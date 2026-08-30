import asyncio
import logging
import os
import re
import sys
import time
import uuid
from contextlib import asynccontextmanager
from typing import List, Dict, Optional, Tuple, Literal
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel, model_validator
from telethon import TelegramClient, errors, functions
from telethon.sessions import StringSession
from telethon import password as pwd_mod
from pydantic_settings import BaseSettings, SettingsConfigDict
from loguru import logger
import socks


class InterceptHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            level = logger.level(record.levelname).name
        except ValueError:
            level = record.levelno
        logger.opt(depth=6, exception=record.exc_info).log(level, record.getMessage())


_STRING_SESSION_RE = re.compile(r"[A-Za-z0-9+/=_-]{100,}")
_SECRET_KEYS = ("session_string", "phone_code_hash", "password", "api_hash", "api_id")


def _redact_message(msg: str) -> str:
    msg = _STRING_SESSION_RE.sub("***", msg)
    for key in _SECRET_KEYS:
        msg = re.sub(
            rf"\b({re.escape(key)})\b(\s*[:=]\s*)([\"']?)([^\"',}}\]\s]+)",
            lambda m: f"{m.group(1)}{m.group(2)}{m.group(3)}***",
            msg,
            flags=re.IGNORECASE,
        )
    return msg


def _redact(record) -> bool:
    record["message"] = _redact_message(record["message"])
    return True


def _resolve_log_level() -> str:
    name = os.getenv("LOG_LEVEL", "INFO").upper()
    try:
        logger.level(name)
        return name
    except ValueError:
        return "INFO"


LOG_LEVEL = _resolve_log_level()

logger.remove()


def _stdout_sink(message) -> None:
    # Redaction must happen on the *rendered* output so tracebacks (which are
    # appended during formatting, after the per-record filter runs) get scrubbed
    # too — otherwise Settings(...) frames would leak API_HASH etc.
    sys.stdout.write(_redact_message(str(message)))


logger.add(
    _stdout_sink,
    level=LOG_LEVEL,
    colorize=True,
    diagnose=False,
    format=(
        "<green>{time:YYYY-MM-DD HH:mm:ss}</green> | "
        "<level>{level: <8}</level> | "
        "<cyan>{name}</cyan>:<cyan>{function}</cyan>:<cyan>{line}</cyan> - "
        "<level>{message}</level>"
    ),
    filter=_redact,
)

logging.basicConfig(handlers=[InterceptHandler()], level=0)
logging.getLogger().addHandler(InterceptHandler())


class Settings(BaseSettings):
    API_ID: int
    API_HASH: str
    SOCKS5_HOST: str = ""
    SOCKS5_PORT: int = 0
    SOCKS5_USERNAME: Optional[str] = None
    SOCKS5_PASSWORD: Optional[str] = None

    model_config = SettingsConfigDict(env_file=".env")

    @model_validator(mode="after")
    def _validate_socks5(self) -> "Settings":
        if self.SOCKS5_HOST:
            if not (1 <= self.SOCKS5_PORT <= 65535):
                raise ValueError(
                    "SOCKS5_PORT must be an integer in 1..65535 when SOCKS5_HOST is set"
                )
        elif self.SOCKS5_PORT:
            raise ValueError("SOCKS5_PORT is set but SOCKS5_HOST is empty")

        if (self.SOCKS5_USERNAME is None) != (self.SOCKS5_PASSWORD is None):
            raise ValueError(
                "SOCKS5_USERNAME and SOCKS5_PASSWORD must be set together or both be empty"
            )
        return self

settings = Settings()


def _build_proxy(cfg: Settings) -> Optional[Tuple]:
    if not cfg.SOCKS5_HOST:
        return None
    return (
        socks.SOCKS5,
        cfg.SOCKS5_HOST,
        cfg.SOCKS5_PORT,
        True,
        cfg.SOCKS5_USERNAME,
        cfg.SOCKS5_PASSWORD,
    )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # uvicorn reconfigures its loggers on startup; silence its access logger
    # so the middleware below is the single source of access logs.
    logging.getLogger("uvicorn.access").disabled = True
    yield


app = FastAPI(title="AIESEC Moscow Telegram Unified Backend", lifespan=lifespan)


@app.middleware("http")
async def access_log(request, call_next):
    start = time.perf_counter()
    response = await call_next(request)
    dur_ms = (time.perf_counter() - start) * 1000
    logger.info(
        "{method} {path} -> {status} ({dur:.1f} ms) from {client}",
        method=request.method,
        path=request.url.path,
        status=response.status_code,
        dur=dur_ms,
        client=request.client.host if request.client else "-",
    )
    return response


# Store for job statuses (mutated in place by background tasks; rendered
# into a JobStatus on each GET /job/{job_id} call).
jobs_db: Dict[str, Dict] = {}

# Store for in-flight Telegram QR login flows. A background task polls the
# underlying TelegramClient (via QRLogin.wait()) and mutates the entry's
# status; the GET endpoint evicts entries once a terminal status is returned.
# When status is "password_required" the entry keeps the live client so the
# password endpoint can complete the auth.checkPassword round-trip.
qr_logins: Dict[str, Dict] = {}

class AuthSendCode(BaseModel):
    """
    Request model for sending authentication code to Telegram.
    
    Attributes:
        phone_number (str): The phone number to send the verification code to.
                           Must be in international format (e.g., +1234567890).
    """
    phone_number: str

class AuthSendCodeResponse(BaseModel):
    """
    Response model for authentication code request.
    
    Attributes:
        phone_number (str): The phone number that the code was sent to.
        phone_code_hash (str): A unique hash provided by Telegram to verify 
                              the code request. Must be stored and sent back 
                              during sign-in.
        session_string (str): Serialized session data that must be stored 
                             by the client and used for subsequent API calls.
    """
    phone_number: str
    phone_code_hash: str
    session_string: str

class AuthSignIn(BaseModel):
    """
    Request model for completing Telegram authentication.
    
    Attributes:
        session_string (str): The session string received from the send-code endpoint.
        phone_code_hash (str): The phone code hash received from the send-code endpoint.
        phone_number (str): The phone number used in the initial code request.
        verification_code (str): The 5-digit code received via SMS/Telegram.
        password (Optional[str]): Two-factor authentication password, if required.
                                 Only needed if the account has 2FA enabled.
    """
    session_string: str
    phone_code_hash: str
    phone_number: str
    verification_code: str
    password: Optional[str] = None

class AuthSignInResponse(BaseModel):
    """
    Response model for successful authentication.

    Attributes:
        session_string (str): Updated session string that should be used for
                             all subsequent authenticated API calls.
                             This session is now fully authenticated and ready
                             to send messages.
    """
    session_string: str

class AuthSignInSessionRequest(BaseModel):
    """
    Request model for signing in with an existing Telegram StringSession.

    Attributes:
        session_string (str): Serialized Telethon StringSession obtained
                              previously (e.g. via client.session.save()).
    """
    session_string: str

class AuthSignInSessionResponse(BaseModel):
    """
    Response model for successful session-string sign-in.

    Attributes:
        session_string (str): Updated session string that should be used for
                             all subsequent authenticated API calls. Telegram
                             may rotate auth keys, so the returned string can
                             differ from the input.
    """
    session_string: str

class AuthQrStartResponse(BaseModel):
    """
    Response model for starting a Telegram QR login flow.

    Attributes:
        qr_id (str): Server-side identifier the client uses to poll for status.
        qr_url (str): The ``tg://login?token=...`` URL to encode into a QR
                      code. Scanning this from another Telegram client will
                      authorize the in-flight backend session.
    """
    qr_id: str
    qr_url: str

class AuthQrStatusResponse(BaseModel):
    """
    Response model for polling the status of a Telegram QR login flow.

    Attributes:
        status (Literal["pending", "password_required", "success", "expired", "error"]):
            "pending" while waiting for the user to scan the QR;
            "password_required" after the user has confirmed the QR scan on
            another device but their account has 2FA enabled (the frontend
            should prompt for the 2FA password and POST it back);
            "success" once the user has confirmed on another device
            (session_string is populated);
            "expired" if the QR token expired before being scanned;
            "error" for any other failure (error is populated).
        session_string (Optional[str]): Authenticated StringSession when
                                       status is "success"; None otherwise.
        error (Optional[str]): Human-readable error message when status is
                               "error"; None otherwise.
    """
    status: Literal["pending", "password_required", "success", "expired", "error"]
    session_string: Optional[str] = None
    error: Optional[str] = None

class AuthQrPasswordRequest(BaseModel):
    """
    Request model for submitting the 2FA password to complete a Telegram
    QR login flow whose status is "password_required".

    Attributes:
        password (str): The user's Telegram cloud (2FA) password.
    """
    password: str

class MessagingJob(BaseModel):
    """
    Request model for creating a mass messaging job.

    Attributes:
        session_string (str): Authenticated session string from sign-in endpoint.
        usernames (List[str]): List of Telegram usernames or phone numbers to send
                              messages to. Each username should be a valid
                              Telegram handle (e.g., "username" or "@username").
        message (str): The message text to send to all specified users.
                      Maximum length should comply with Telegram's message limits.
    """
    session_string: str
    usernames: List[str]
    message: str


class RecipientResult(BaseModel):
    """
    Per-recipient result of a messaging job.

    Attributes:
        recipient (str): Username (or phone number) this result refers to.
        status (Literal["sent", "failed"]): Outcome for this recipient.
        error (Optional[str]): Name of the exception class (e.g.
                               "UsernameNotOccupiedError") when status is "failed".
                               None when status is "sent".
    """
    recipient: str
    status: Literal["sent", "failed"]
    error: Optional[str] = None


class JobStatus(BaseModel):
    """
    Full job status returned by GET /job/{job_id}.

    Attributes:
        job_id (str): Unique identifier of the job.
        status (Literal["Processing", "Completed", "Failed"]): Job-level state.
        total (int): Total number of recipients in the job.
        sent (int): Number of recipients successfully contacted so far.
        failed (int): Number of recipients that failed so far.
        current (Optional[str]): Username currently being processed; None when
                                 the job is not actively processing.
        results (List[RecipientResult]): Per-recipient outcomes, appended in the
                                         order they were processed.
        error (Optional[str]): Job-level error class name (e.g. "AuthKeyError")
                               when status is "Failed"; None otherwise.
    """
    job_id: str
    status: Literal["Processing", "Completed", "Failed"]
    total: int
    sent: int
    failed: int
    current: Optional[str] = None
    results: List[RecipientResult]
    error: Optional[str] = None


# --- Background Task ---

async def mass_messaging_task(job_id: str, session: str, usernames: List[str], text: str):
    """
    Background task to send messages to multiple users with rate limit handling.

    Updates jobs_db[job_id] in place with per-recipient results and a job-level
    status. FloodWaitError is treated as a transparent retry (not a failure):
    after sleeping we re-attempt the same recipient; a second exception there
    is then recorded as a failure with the exception class name.
    """
    jobs_db[job_id] = {
        "status": "Processing",
        "total": len(usernames),
        "sent": 0,
        "failed": 0,
        "current": None,
        "results": [],
        "error": None,
    }
    logger.info(
        "mass_messaging_task job_id={job_id} total={total}",
        job_id=job_id,
        total=len(usernames),
    )
    proxy = _build_proxy(settings)
    client = None

    try:
        client = TelegramClient(StringSession(session), settings.API_ID, settings.API_HASH, proxy=proxy)
        await client.connect()

        for username in usernames:
            jobs_db[job_id]["current"] = username
            try:
                await client.send_message(username, text)
                jobs_db[job_id]["results"].append(
                    {"recipient": username, "status": "sent", "error": None}
                )
                jobs_db[job_id]["sent"] += 1
                logger.info(
                    "job_id={job_id} recipient={recipient} status=sent",
                    job_id=job_id,
                    recipient=username,
                )
                await asyncio.sleep(20)
            except errors.FloodWaitError as e:
                logger.warning(
                    "job_id={job_id} recipient={recipient} flood_wait seconds={seconds}",
                    job_id=job_id,
                    recipient=username,
                    seconds=e.seconds,
                )
                await asyncio.sleep(e.seconds)
                try:
                    await client.send_message(username, text)
                    jobs_db[job_id]["results"].append(
                        {"recipient": username, "status": "sent", "error": None}
                    )
                    jobs_db[job_id]["sent"] += 1
                    logger.info(
                        "job_id={job_id} recipient={recipient} status=sent (after flood_wait)",
                        job_id=job_id,
                        recipient=username,
                    )
                except Exception as retry_e:
                    jobs_db[job_id]["results"].append(
                        {
                            "recipient": username,
                            "status": "failed",
                            "error": type(retry_e).__name__,
                        }
                    )
                    jobs_db[job_id]["failed"] += 1
                    logger.info(
                        "job_id={job_id} recipient={recipient} status=failed error={error}",
                        job_id=job_id,
                        recipient=username,
                        error=type(retry_e).__name__,
                    )
            except Exception as e:
                jobs_db[job_id]["results"].append(
                    {
                        "recipient": username,
                        "status": "failed",
                        "error": type(e).__name__,
                    }
                )
                jobs_db[job_id]["failed"] += 1
                logger.info(
                    "job_id={job_id} recipient={recipient} status=failed error={error}",
                    job_id=job_id,
                    recipient=username,
                    error=type(e).__name__,
                )

        jobs_db[job_id]["status"] = "Completed"
        logger.info(
            "job_id={job_id} status=Completed sent={sent} failed={failed}",
            job_id=job_id,
            sent=jobs_db[job_id]["sent"],
            failed=jobs_db[job_id]["failed"],
        )
    except Exception as e:
        jobs_db[job_id]["status"] = "Failed"
        jobs_db[job_id]["error"] = type(e).__name__
        logger.opt(exception=True).error(
            "job_id={job_id} status=Failed error={error}",
            job_id=job_id,
            error=type(e).__name__,
        )
    finally:
        jobs_db[job_id]["current"] = None
        if client and client.is_connected():
            await client.disconnect()

@app.post("/auth/send-code", response_model=AuthSendCodeResponse)
async def send_code(data: AuthSendCode) -> AuthSendCodeResponse:
    """
    Request a verification code from Telegram for authentication.
    
    This is the first step in the Telegram authentication flow. It sends a 
    verification code to the provided phone number and returns necessary 
    session data for completing authentication.
    
    Args:
        data (AuthSendCode): Phone number to send verification code to.
        
    Returns:
        AuthSendCodeResponse: Contains phone number, phone code hash, and 
                             session string needed for the sign-in step.
                             
    Raises:
        HTTPException: 
            - 400: If the phone number is invalid or Telegram returns an error.
            - 401: If the phone number is not registered with Telegram.
            
    Note:
        The client must store both the session_string and phone_code_hash 
        to complete the authentication process in the next step.
    """
    logger.info("send_code phone=***{last4}", last4=data.phone_number[-4:])
    client = TelegramClient(StringSession(), settings.API_ID, settings.API_HASH, proxy=_build_proxy(settings))
    await client.connect()
    try:
        sent_code = await client.send_code_request(data.phone_number)
        session_string = client.session.save()
        logger.info("send_code succeeded phone=***{last4}", last4=data.phone_number[-4:])
        return AuthSendCodeResponse(session_string=session_string, phone_code_hash=sent_code.phone_code_hash, phone_number=data.phone_number)
    except Exception as e:
        logger.exception("send_code failed phone=***{last4}", last4=data.phone_number[-4:])
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        if client.is_connected():
            await client.disconnect()

@app.post("/auth/sign-in", response_model=AuthSignInResponse)
async def sign_in(data: AuthSignIn) -> AuthSignInResponse:
    """
    Complete Telegram authentication using verification code.
    
    This is the second step in the Telegram authentication flow. It uses the 
    verification code received via SMS/Telegram along with the session data 
    from the send-code step to complete authentication.
    
    Args:
        data (AuthSignIn): Authentication data including session string, 
                          phone code hash, phone number, verification code, 
                          and optional 2FA password.
                          
    Returns:
        AuthSignInResponse: Contains the authenticated session string that 
                           should be used for all subsequent API calls requiring 
                           authentication.
                           
    Raises:
        HTTPException:
            - 400: If verification code is invalid or authentication fails.
            - 401: If 2FA password is required but not provided, or if the 
                   provided 2FA password is incorrect.
                   
    Note:
        If the account has two-factor authentication enabled, the initial 
sign_in call will raise SessionPasswordNeededError, and a second 
    call with the password parameter is required.
    """
    logger.info("sign_in phone=***{last4} has_password={has_pw}", last4=data.phone_number[-4:], has_pw=data.password is not None)
    client = TelegramClient(StringSession(data.session_string), settings.API_ID, settings.API_HASH, proxy=_build_proxy(settings))
    await client.connect()
    try:
        try:
            await client.sign_in(
                phone=data.phone_number,
                code=data.verification_code,
                phone_code_hash=data.phone_code_hash
            )
        except errors.SessionPasswordNeededError:
            logger.info("sign_in requires 2FA phone=***{last4}", last4=data.phone_number[-4:])
            if data.password is None:
                raise HTTPException(
                    status_code=401,
                    detail={"detail": "2FA Password required", "code": "password_required"},
                )
            await client.sign_in(password=data.password)
    except errors.PasswordHashInvalidError:
        logger.warning("sign_in invalid 2FA password phone=***{last4}", last4=data.phone_number[-4:])
        raise HTTPException(
            status_code=401,
            detail={"detail": "Invalid 2FA password", "code": "invalid_password"},
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("sign_in failed phone=***{last4}", last4=data.phone_number[-4:])
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        if client.is_connected():
            await client.disconnect()
    logger.info("sign_in succeeded phone=***{last4}", last4=data.phone_number[-4:])
    return AuthSignInResponse(session_string=client.session.save())

@app.post("/auth/sign-in-session", response_model=AuthSignInSessionResponse)
async def sign_in_with_session(data: AuthSignInSessionRequest) -> AuthSignInSessionResponse:
    """
    Sign in using an existing Telethon StringSession.

    Skips the phone-number / SMS-code / 2FA flow for callers that already have
    a serialized session. The session is re-saved after validation because
    Telegram may rotate auth keys; the returned string should be used for all
    subsequent authenticated API calls.

    Args:
        data (AuthSignInSessionRequest): The serialized StringSession to validate.

    Returns:
        AuthSignInSessionResponse: Contains the (possibly rotated) session
                                  string that should be used for subsequent
                                  requests.

    Raises:
        HTTPException:
            - 400: If the session string is malformed, not a valid Telethon
                   StringSession, or Telethon fails to connect.
            - 401: If the session is well-formed but the user is not
                   authorized (e.g. the session has been logged out or has
                   expired).
    """
    logger.info("sign_in_session: validating session")
    client = None
    try:
        client = TelegramClient(StringSession(data.session_string), settings.API_ID, settings.API_HASH, proxy=_build_proxy(settings))
        await client.connect()
        authorized = await client.is_user_authorized()
        logger.info("sign_in_session authorized={auth}", auth=authorized)
        if not authorized:
            raise HTTPException(
                status_code=401,
                detail="Invalid or expired session",
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("sign_in_session failed")
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        if client is not None and client.is_connected():
            await client.disconnect()
    logger.info("sign_in_session succeeded")
    return AuthSignInSessionResponse(session_string=client.session.save())

@app.post("/job")
async def create_messaging_job(job_data: MessagingJob, background_tasks: BackgroundTasks):
    """
    Create a new mass messaging job to send messages to multiple users.
    
    This endpoint initiates an asynchronous background task to send the 
    specified message to all provided usernames. The job runs in the background 
    and handles Telegram's rate limiting automatically.
    
    Args:
        job_data (MessagingJob): Contains authenticated session string, 
                                list of usernames, and message text.
        background_tasks (BackgroundTasks): FastAPI background tasks manager.
        
    Returns:
        dict: Contains job_id (str) for tracking and initial status message.
              Example: {"job_id": "uuid-string", "status": "Job started asynchronously"}
              
    Note:
        - The job runs asynchronously and may take time to complete depending 
          on the number of recipients and Telegram's rate limits.
        - Use the GET /job/{job_id} endpoint to check job status.
        - Each message send operation includes a 2-second delay to avoid 
          immediate rate limiting, with additional delays if FloodWaitError occurs.
    """
    job_id = str(uuid.uuid4())

    logger.info(
        "create_messaging_job job_id={job_id} recipients={n}",
        job_id=job_id,
        n=len(job_data.usernames),
    )

    # We pass the session_string directly into the worker
    background_tasks.add_task(
        mass_messaging_task,
        job_id,
        job_data.session_string,
        job_data.usernames,
        job_data.message
    )

    return {"job_id": job_id, "status": "Job started asynchronously"}

@app.get("/job/{job_id}", response_model=JobStatus)
async def get_job_status(job_id: str):
    """
    Retrieve the current status of a messaging job.

    Returns the full JobStatus object including per-recipient results.
    The job state is stored in memory and may be lost if the server restarts.
    """
    state = jobs_db.get(job_id)
    if not state:
        raise HTTPException(status_code=404, detail="Job not found")
    return JobStatus(job_id=job_id, **state)


async def _qr_wait_task(qr_id: str, client: TelegramClient):
    """
    Background task that waits for a QR login to complete.

    Mutates ``qr_logins[qr_id]`` in place with the terminal status. On any
    outcome (success, expiry, error) the underlying TelegramClient is
    disconnected so it does not linger in the server. ``password_required``
    is a non-terminal status — the client must stay alive so a subsequent
    POST to ``/auth/qr/{qr_id}/password`` can complete the auth.checkPassword
    flow against the same session.
    """
    try:
        qr = qr_logins[qr_id]["qr"]
        await qr.wait()
        qr_logins[qr_id]["session_string"] = client.session.save()
        qr_logins[qr_id]["status"] = "success"
        logger.info("_qr_wait_task status=success qr_id={qr_id}", qr_id=qr_id)
    except asyncio.TimeoutError:
        qr_logins[qr_id]["status"] = "expired"
        logger.info("_qr_wait_task status=expired qr_id={qr_id}", qr_id=qr_id)
    except errors.SessionPasswordNeededError:
        qr_logins[qr_id]["status"] = "password_required"
        logger.info("_qr_wait_task status=password_required qr_id={qr_id}", qr_id=qr_id)
    except Exception as e:
        qr_logins[qr_id]["status"] = "error"
        qr_logins[qr_id]["error"] = str(e)
        logger.opt(exception=True).error(
            "_qr_wait_task status=error qr_id={qr_id}", qr_id=qr_id
        )
    finally:
        if qr_logins.get(qr_id, {}).get("status") != "password_required":
            try:
                if client.is_connected():
                    await client.disconnect()
            except Exception:
                pass


@app.post("/auth/qr/start", response_model=AuthQrStartResponse)
async def start_qr_login() -> AuthQrStartResponse:
    """
    Start a Telegram QR login flow.

    Creates a fresh unauthorized TelegramClient, requests a login token via
    ``auth.exportLoginToken``, stores the live client keyed by ``qr_id``, and
    spawns a background task that waits for the user to confirm on another
    device. The QR URL is returned for the caller to render as a QR code.

    Raises:
        HTTPException:
            - 400: If Telegram refuses to issue a login token.
    """
    logger.info("start_qr_login: requesting QR token")
    client = TelegramClient(
        StringSession(),
        settings.API_ID,
        settings.API_HASH,
        proxy=_build_proxy(settings),
    )
    await client.connect()
    try:
        qr = await client.qr_login()
    except Exception as e:
        logger.opt(exception=True).error("start_qr_login: qr_login failed")
        if client.is_connected():
            await client.disconnect()
        raise HTTPException(status_code=400, detail=str(e))

    qr_id = str(uuid.uuid4())
    qr_logins[qr_id] = {
        "client": client,
        "qr": qr,
        "status": "pending",
        "session_string": None,
        "error": None,
    }
    asyncio.create_task(_qr_wait_task(qr_id, client))
    logger.info("start_qr_login: qr_id={qr_id}", qr_id=qr_id)

    return AuthQrStartResponse(qr_id=qr_id, qr_url=qr.url)


@app.get("/auth/qr/{qr_id}", response_model=AuthQrStatusResponse)
async def get_qr_status(qr_id: str) -> AuthQrStatusResponse:
    """
    Poll the status of a previously-started QR login flow.

    On the first call that observes a terminal status (success/expired/error)
    the entry is evicted so subsequent calls return 404. Pending calls are a
    no-op against the entry.

    Raises:
        HTTPException:
            - 404: If ``qr_id`` is unknown or has already been consumed.
    """
    entry = qr_logins.get(qr_id)
    if not entry:
        raise HTTPException(status_code=404, detail="QR login not found")

    status = entry["status"]
    if status == "success":
        qr_logins.pop(qr_id, None)
        return AuthQrStatusResponse(
            status="success", session_string=entry["session_string"]
        )
    if status in ("expired", "error"):
        qr_logins.pop(qr_id, None)
        return AuthQrStatusResponse(status=status, error=entry["error"])
    if status == "password_required":
        return AuthQrStatusResponse(status="password_required")
    return AuthQrStatusResponse(status="pending")


@app.post("/auth/qr/{qr_id}/password")
async def submit_qr_password(qr_id: str, data: AuthQrPasswordRequest):
    """
    Submit the 2FA password for a QR login flow whose status is
    "password_required".

    Completes the auth.checkPassword round-trip on the still-connected
    TelegramClient, then marks the entry "success" so the next
    GET /auth/qr/{qr_id} returns the authenticated session string.

    Raises:
        HTTPException:
            - 404: If ``qr_id`` is unknown or has already been consumed.
            - 400: If the flow is not in "password_required" state.
            - 401: With code "invalid_password" if the password is wrong.
            - 400: For any other checkPassword failure.
    """
    logger.info("submit_qr_password qr_id={qr_id}", qr_id=qr_id)
    entry = qr_logins.get(qr_id)
    if not entry:
        raise HTTPException(status_code=404, detail="QR login not found")
    if entry["status"] != "password_required":
        raise HTTPException(
            status_code=400,
            detail=f"QR login is in state '{entry['status']}', not 'password_required'",
        )

    client: TelegramClient = entry["client"]
    try:
        pwd = await client(functions.account.GetPasswordRequest())
        result = await client(
            functions.auth.CheckPasswordRequest(
                pwd_mod.compute_check(pwd, data.password)
            )
        )
        await client._on_login(result.user)
        entry["session_string"] = client.session.save()
        entry["status"] = "success"
        logger.info("submit_qr_password succeeded qr_id={qr_id}", qr_id=qr_id)
    except errors.PasswordHashInvalidError:
        logger.warning("submit_qr_password invalid 2FA qr_id={qr_id}", qr_id=qr_id)
        raise HTTPException(
            status_code=401,
            detail={"detail": "Invalid 2FA password", "code": "invalid_password"},
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.opt(exception=True).error(
            "submit_qr_password failed qr_id={qr_id}", qr_id=qr_id
        )
        entry["status"] = "error"
        entry["error"] = str(e)
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        try:
            if client.is_connected():
                await client.disconnect()
        except Exception:
            pass
    return {"status": "ok"}
