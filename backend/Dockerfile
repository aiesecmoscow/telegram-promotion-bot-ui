# Use Python 3.14 slim image as base
FROM python:3.14

# Set working directory
WORKDIR /app

# Install system dependencies (curl for health checks)
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl

# Install uv package manager
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Copy application code and assets
COPY . /app

# Install dependencies using uv
RUN uv sync

# Create non-root user for security
RUN useradd -m -u 1000 app && \
    chown -R app:app /app

# Switch to non-root user
USER app

# Set Python path to use uv's virtual environment
ENV PATH="/app/.venv/bin:$PATH"

# Expose health check port
EXPOSE 8080

# Run the bot
CMD ["fastapi", "run", "/app/main.py", "--port", "8000", "--host", "0.0.0.0"]
