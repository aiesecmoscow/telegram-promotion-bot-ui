import asyncio
import uuid
from typing import List, Dict, Optional, Tuple, Literal
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel, model_validator
from telethon import TelegramClient, errors
from telethon.sessions import StringSession
from pydantic_settings import BaseSettings, SettingsConfigDict
import socks

# REDACTED_SESSION=

class Settings(BaseSettings):
    API_ID: int = REDACTED
    API_HASH: str = "REDACTED"
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

app = FastAPI(title="AIESEC Moscow Telegram Unified Backend")

# Store for job statuses (mutated in place by background tasks; rendered
# into a JobStatus on each GET /job/{job_id} call).
jobs_db: Dict[str, Dict] = {}

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
                await asyncio.sleep(20)
            except errors.FloodWaitError as e:
                await asyncio.sleep(e.seconds)
                try:
                    await client.send_message(username, text)
                    jobs_db[job_id]["results"].append(
                        {"recipient": username, "status": "sent", "error": None}
                    )
                    jobs_db[job_id]["sent"] += 1
                except Exception as retry_e:
                    jobs_db[job_id]["results"].append(
                        {
                            "recipient": username,
                            "status": "failed",
                            "error": type(retry_e).__name__,
                        }
                    )
                    jobs_db[job_id]["failed"] += 1
            except Exception as e:
                jobs_db[job_id]["results"].append(
                    {
                        "recipient": username,
                        "status": "failed",
                        "error": type(e).__name__,
                    }
                )
                jobs_db[job_id]["failed"] += 1

        jobs_db[job_id]["status"] = "Completed"
    except Exception as e:
        jobs_db[job_id]["status"] = "Failed"
        jobs_db[job_id]["error"] = type(e).__name__
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
    client = TelegramClient(StringSession(), settings.API_ID, settings.API_HASH, proxy=_build_proxy(settings))
    await client.connect()
    try:
        sent_code = await client.send_code_request(data.phone_number)
        session_string = client.session.save()
        return AuthSendCodeResponse(session_string=session_string, phone_code_hash=sent_code.phone_code_hash, phone_number=data.phone_number)
    except Exception as e:
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
            if data.password is None:
                raise HTTPException(
                    status_code=401,
                    detail={"detail": "2FA Password required", "code": "password_required"},
                )
            await client.sign_in(password=data.password)
    except errors.PasswordHashInvalidError:
        raise HTTPException(
            status_code=401,
            detail={"detail": "Invalid 2FA password", "code": "invalid_password"},
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        if client.is_connected():
            await client.disconnect()
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
    client = None
    try:
        client = TelegramClient(StringSession(data.session_string), settings.API_ID, settings.API_HASH, proxy=_build_proxy(settings))
        await client.connect()
        authorized = await client.is_user_authorized()
        if not authorized:
            raise HTTPException(
                status_code=401,
                detail="Invalid or expired session",
            )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        if client is not None and client.is_connected():
            await client.disconnect()
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
