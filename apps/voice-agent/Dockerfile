FROM python:3.12.14-slim-bookworm

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_NO_CACHE=1

RUN useradd --uid 10001 --create-home --user-group msvaagent \
 && install -d -o msvaagent -g msvaagent -m 0700 /var/lib/msva-voice-agent
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv==0.12.17 && uv sync --frozen --no-dev --no-install-project
COPY src ./src
RUN uv sync --frozen --no-dev && chown -R msvaagent:msvaagent /app
USER msvaagent

EXPOSE 8081
CMD ["uv", "run", "--frozen", "python", "-m", "madhusudan_voice.main", "start"]
