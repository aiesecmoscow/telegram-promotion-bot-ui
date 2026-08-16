import asyncio
import uuid
from typing import List, Dict, Optional
from fastapi import FastAPI, HTTPException, BackgroundTasks
from pydantic import BaseModel
from telethon import TelegramClient, errors
from telethon.sessions import StringSession
from pydantic_settings import BaseSettings, SettingsConfigDict

# REDACTED_SESSION=

class Settings(BaseSettings):
    API_ID: int = REDACTED
    API_HASH: str = "REDACTED"
    
    model_config = SettingsConfigDict(env_file=".env")

settings = Settings()

app = FastAPI(title="AIESEC Moscow Telegram Unified Backend")

# Store for job statuses
jobs_db: Dict[str, str] = {}

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

# --- Background Task ---

async def mass_messaging_task(job_id: str, session: str, usernames: List[str], text: str):
    """
    Background task to send messages to multiple users with rate limit handling.
    
    This function runs asynchronously in the background and handles Telegram's
    rate limiting (FloodWaitError) by automatically pausing and resuming
    message sending as needed.
    
    Args:
        job_id (str): Unique identifier for tracking the messaging job status.
        session (str): Serialized Telegram client session string.
        usernames (List[str]): List of usernames to send messages to.
        text (str): Message text to send to all users.
        
    Updates:
        jobs_db (Dict[str, str]): Updates job status in the global job store:
            - "Processing": Job is actively sending messages
            - "Completed": All messages sent successfully
            - "Failed: {error}": Job failed with specific error message
    """
    jobs_db[job_id] = "Processing"
    
    try:
        # Initialize client with the provided session string
        client = TelegramClient(StringSession(session), settings.API_ID, settings.API_HASH)
        await client.connect()
        
        for username in usernames:
            try:
                await client.send_message(username, text)
                # Small sleep to avoid immediate FloodWait
                await asyncio.sleep(20) 
            except errors.FloodWaitError as e:
                await asyncio.sleep(e.seconds)
                await client.send_message(username, text)
            except Exception as e:
                print(f"Failed to send to {username}: {e}")

        jobs_db[job_id] = "Completed"
    except Exception as e:
        jobs_db[job_id] = f"Failed: {str(e)}"
    finally:
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
    client = TelegramClient(StringSession(), settings.API_ID, settings.API_HASH)
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
    client = TelegramClient(StringSession(data.session_string), settings.API_ID, settings.API_HASH)
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
        client = TelegramClient(StringSession(data.session_string), settings.API_ID, settings.API_HASH)
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

@app.get("/job/{job_id}")
async def get_job_status(job_id: str):
    """
    Retrieve the current status of a messaging job.
    
    Check the progress or completion status of a previously created 
    messaging job using its unique job identifier.
    
    Args:
        job_id (str): Unique identifier of the messaging job returned by 
                     the create_messaging_job endpoint.
                     
    Returns:
        dict: Contains job_id and current status. Possible status values:
              - "Processing": Job is actively sending messages
              - "Completed": All messages have been sent successfully
              - "Failed: {error}": Job failed with the specified error message
              
    Raises:
        HTTPException:
            - 404: If the job_id does not exist or has been cleaned up
            
    Note:
        Job status is stored in memory and may be lost if the server restarts.
        For production use, consider implementing persistent job storage.
    """
    status = jobs_db.get(job_id)
    if not status:
        raise HTTPException(status_code=404, detail="Job not found")
    return {"job_id": job_id, "status": status}
