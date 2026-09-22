"""Vercel serverless entrypoint for the Silvestar FastAPI app.

Vercel's Python runtime imports `app` from `api/index.py`, so we append the
services/api directory to sys.path and re-export the FastAPI application.
Cold-start pooling is kept tiny (serverless scales horizontally).
"""
import os
import sys

_API_DIR = os.path.join(os.path.dirname(__file__), "..", "services", "api")
sys.path.insert(0, os.path.abspath(_API_DIR))

# Serverless: keep the asyncpg pool minimal so concurrent lambdas don't
# exhaust Render Postgres free-tier connection slots.
os.environ.setdefault("SILVESTAR_DB_POOL_MAX", "2")

from app.main import app  # noqa: E402

runtime = app  # Vercel looks for `app` — alias kept for clarity
