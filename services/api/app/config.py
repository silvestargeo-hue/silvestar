"""Silvestar platform configuration.

Every infra dependency is URL-driven: when a real service URL is present the
production driver is used; otherwise an embedded engine takes over so the
platform is always fully functional.
"""
import os
from dataclasses import dataclass, field


def _bool(v: str) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    app_name: str = "Silvestar Platform"
    version: str = "1.0.0"

    # --- Module 3/4: database (pgvector) ---
    database_url: str = field(
        default_factory=lambda: os.getenv("DATABASE_URL")
        or os.getenv("POSTGRES_URL_NON_POOLING")
        or os.getenv("POSTGRES_URL")
        or ""
    )
    # --- Module 8: cache ---
    redis_url: str = field(default_factory=lambda: os.getenv("REDIS_URL", ""))
    # --- Module 7: graph ---
    neo4j_url: str = field(default_factory=lambda: os.getenv("NEO4J_URL", ""))
    neo4j_user: str = field(default_factory=lambda: os.getenv("NEO4J_USER", "neo4j"))
    neo4j_password: str = field(default_factory=lambda: os.getenv("NEO4J_PASSWORD", ""))
    # --- Module 6: realtime ---
    livekit_url: str = field(default_factory=lambda: os.getenv("LIVEKIT_URL", ""))
    livekit_api_key: str = field(default_factory=lambda: os.getenv("LIVEKIT_API_KEY", ""))
    livekit_api_secret: str = field(default_factory=lambda: os.getenv("LIVEKIT_API_SECRET", ""))
    # --- Module 9: AI ---
    ai_primary_url: str = field(default_factory=lambda: os.getenv("AI_PRIMARY_URL", "https://text.pollinations.ai/openai"))
    ai_fallback_url: str = field(default_factory=lambda: os.getenv("AI_FALLBACK_URL", "https://text.pollinations.ai"))
    ai_model: str = field(default_factory=lambda: os.getenv("AI_MODEL", "openai"))
    ai_api_key: str = field(default_factory=lambda: os.getenv(
        "AI_API_KEY", os.getenv("OPENROUTER_API_KEY", os.getenv("OPENAI_API_KEY", ""))))
    ai_failover_models: list = field(default_factory=lambda: [
        m for m in os.getenv("AI_FAILOVER_MODELS",
                             "nvidia/nemotron-3.5-lightning:free,z-ai/glm-5.2:free").split(",") if m])
    ai_timeout: float = field(default_factory=lambda: float(os.getenv("AI_TIMEOUT", "20")))
    ai_budget_s: float = field(default_factory=lambda: float(os.getenv("AI_BUDGET_S", "45")))
    puter_proxy_url: str = field(default_factory=lambda: os.getenv("PUTER_PROXY_URL", ""))
    # --- Security ---
    secret_key: str = field(default_factory=lambda: os.getenv("SECRET_KEY", "silvestar-dev-secret-change-me"))
    admin_key: str = field(default_factory=lambda: os.getenv("SILVESTAR_ADMIN_KEY", "silvestar-admin"))
    # --- Email (OTP delivery) — absent SMTP falls back to dev-code responses ---
    smtp_host: str = field(default_factory=lambda: os.getenv("SMTP_HOST", ""))
    smtp_port: int = field(default_factory=lambda: int(os.getenv("SMTP_PORT", "587")))
    smtp_user: str = field(default_factory=lambda: os.getenv("SMTP_USER", ""))
    smtp_password: str = field(default_factory=lambda: os.getenv("SMTP_PASSWORD", ""))
    smtp_from: str = field(default_factory=lambda: os.getenv("SMTP_FROM", ""))
    smtp_tls: bool = field(default_factory=lambda: os.getenv("SMTP_TLS", "1") not in ("0", "false", "no"))
    vault_kdf_iterations: int = field(default_factory=lambda: int(os.getenv("VAULT_KDF_ITERATIONS", "200000")))
    # --- Misc ---
    cors_origins: list = field(default_factory=lambda: [
        o for o in os.getenv("CORS_ORIGINS", "*").split(",") if o
    ] or ["*"])
    embedded_fallbacks: bool = field(default_factory=lambda: _bool(os.getenv("EMBEDDED_FALLBACKS", "1")))
    embedding_dim: int = 256

    @property
    def has_postgres(self) -> bool:
        return bool(self.database_url) and self.database_url.startswith(("postgres", "postgresql"))

    @property
    def has_redis(self) -> bool:
        return bool(self.redis_url)

    @property
    def has_neo4j(self) -> bool:
        return bool(self.neo4j_url)

    @property
    def has_livekit(self) -> bool:
        return bool(self.livekit_url and self.livekit_api_key and self.livekit_api_secret)


settings = Settings()
