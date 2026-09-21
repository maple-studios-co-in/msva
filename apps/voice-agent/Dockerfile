FROM python:3.12.14-slim-bookworm

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_NO_CACHE=1

RUN groupadd --gid 10001 voice && useradd --uid 10001 --gid voice --create-home voice
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv==0.12.17 && uv sync --frozen --no-dev
COPY src ./src
USER voice

EXPOSE 8081
CMD ["uv", "run", "--frozen", "python", "-m", "madhusudan_voice.main", "start"]
