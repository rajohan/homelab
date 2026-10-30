FROM python:3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY scripts/testing/browserEgressFixture.py /fixture.py
ENTRYPOINT ["python", "/fixture.py"]
