"""PostgreSQL 표 (server/db.ts 마이그레이션 v1~v4 + registry.ts의 pin_locks를 합친 지금 모양).

Node(SQLite)와 맞춘 것:
  · 칸 이름 · 순서 · 기본값 · NOT NULL · CHECK · UNIQUE · 색인 이름(posts_at, blocks_until)을 그대로 둡니다.
  · 0/1 표시 칸(keeper, paid, email_public, hidden, repo_ok)은 SQLite처럼 INTEGER 0/1로 둡니다 (기능 코드가 숫자로 씀).
  · deco · screens는 JSON 배열을 글자 그대로(TEXT) 둡니다. JSONB로 바꾸면 글자 모양(순서 · 빈칸)이 달라집니다.
  · ms 시각(at, *_at, until)은 BIGINT. SQLite INTEGER(64비트) 그대로의 범위입니다.
  · AUTOINCREMENT 번호는 IDENTITY(BY DEFAULT). 지운 번호를 다시 쓰지 않는 점이 같습니다.
  · v4 채널별 사당: shrines.channel(기본 1) + UNIQUE(channel, plot), projects.want_channel(NULL = 아무 채널).
PostgreSQL 예약어와 겹치는 칸 이름은 없습니다 (at, day, until, text, domain, operator, action, kind, code는 모두
비예약 키워드라 따옴표 없이 쓸 수 있음). 손으로 쓰는 SQL에서는 그래도 칸 이름을 따옴표로 감싸는 편이 안전합니다.
"""

from __future__ import annotations

from sqlalchemy import BigInteger, CheckConstraint, Identity, Index, Integer, MetaData, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)


def _text(default: str | None = None, *, nullable: bool = False) -> Mapped:
    return mapped_column(Text, nullable=nullable, server_default=default)


def _int(default: str | None = None, *, nullable: bool = False) -> Mapped:
    return mapped_column(Integer, nullable=nullable, server_default=default)


def _ms(*, nullable: bool = False, default: str | None = None) -> Mapped:
    return mapped_column(BigInteger, nullable=nullable, server_default=default)


class Shrine(Base):
    """사당. 사업자등록번호 같은 비공개 정보는 두지 않습니다 (확인한 날짜만)."""

    __tablename__ = "shrines"
    __table_args__ = (
        CheckConstraint("status IN ('live', 'check')", name="status"),
        UniqueConstraint("channel", "plot"),
    )

    slug: Mapped[str] = mapped_column(Text, primary_key=True)
    name: Mapped[str] = _text()
    tagline: Mapped[str] = _text()
    category: Mapped[str] = _text()
    #: GitHub 전용 사당은 github.com/owner/repo
    domain: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    url: Mapped[str] = _text()
    operator: Mapped[str] = _text()
    keeper: Mapped[int] = _int("0")
    paid: Mapped[int] = _int("0")
    #: 빈 글자 또는 YYYY-MM-DD
    verified_domain: Mapped[str] = _text()
    verified_business: Mapped[str | None] = _text(nullable=True)
    #: YYYY-MM-DD (한국 시간)
    joined_at: Mapped[str] = _text()
    status: Mapped[str] = _text()
    prayer: Mapped[str] = _text()
    charm: Mapped[str | None] = _text(nullable=True)
    #: JSON 배열 글자
    deco: Mapped[str] = _text("[]")
    screens: Mapped[str] = _text("[]")
    captured_at: Mapped[str] = _text()
    #: 채널 1~3 (world.ts CHANNELS). 자리는 (channel, plot) 짝으로만 겹치지 않으면 됩니다
    channel: Mapped[int] = _int("1")
    #: 자리 0~19
    plot: Mapped[int] = _int()
    repo: Mapped[str] = _text("")
    email: Mapped[str] = _text("")
    email_public: Mapped[int] = _int("0")
    #: 어느 접수에서 왔는지 (색인 · 외래 키 없음, Node와 같음)
    project_id: Mapped[int] = mapped_column(BigInteger, nullable=False, server_default="0")
    sign: Mapped[str] = _text("")


class Candle(Base):
    """날짜(한국 시간) · 사당 · 기원별 초 개수."""

    __tablename__ = "candles"

    day: Mapped[str] = mapped_column(Text, primary_key=True)
    slug: Mapped[str] = mapped_column(Text, primary_key=True)
    prayer: Mapped[str] = mapped_column(Text, primary_key=True)
    n: Mapped[int] = _int("0")


class AiPrayer(Base):
    """날짜 · AI별 '잘 돌아가게' 기도 수 (지금 코드에서는 쓰지 않음, 표만 둠)."""

    __tablename__ = "ai_prayers"

    day: Mapped[str] = mapped_column(Text, primary_key=True)
    ai: Mapped[str] = mapped_column(Text, primary_key=True)
    n: Mapped[int] = _int("0")


class Post(Base):
    """AI 트렌드 게시판 글 (7일 보관, 자동 닉네임만). 신고 3번이면 hidden."""

    __tablename__ = "posts"
    __table_args__ = (Index("posts_at", "at"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    at: Mapped[int] = _ms()
    topic: Mapped[str] = _text()
    text: Mapped[str] = _text()
    nick: Mapped[str] = _text()
    hidden: Mapped[int] = _int("0")


class PostReport(Base):
    __tablename__ = "post_reports"

    post_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    reporter: Mapped[str] = mapped_column(Text, primary_key=True)


class Project(Base):
    """프로젝트 등록소 접수. 링크는 운영자가 검토한 뒤 사당으로 올라갑니다. PIN은 scrypt 해시('salt:hash')로만."""

    __tablename__ = "projects"
    __table_args__ = (CheckConstraint("status IN ('pending', 'approved', 'rejected', 'withdrawn')", name="status"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    #: 접수 코드 (randomBytes(12) base64url, 16자)
    code: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    at: Mapped[int] = _ms()
    name: Mapped[str] = _text()
    tagline: Mapped[str] = _text()
    category: Mapped[str] = _text()
    github: Mapped[str] = _text("")
    url: Mapped[str] = _text("")
    #: 소문자
    email: Mapped[str] = _text()
    email_public: Mapped[int] = _int("0")
    #: b64url(salt):b64url(scrypt). 파기하면 빈 글자
    pin_hash: Mapped[str] = _text()
    nick: Mapped[str] = _text()
    status: Mapped[str] = _text("pending")
    note: Mapped[str] = _text("")
    slug: Mapped[str] = _text("")
    #: 승인된 프로젝트의 링크 변경 (NULL = 바꾼 것 없음)
    pending_github: Mapped[str | None] = _text(nullable=True)
    pending_url: Mapped[str | None] = _text(nullable=True)
    repo_ok: Mapped[int] = _int("0")
    stars: Mapped[int] = _int("0")
    sign: Mapped[str] = _text("")
    #: DATA_DIR/uploads의 파일 이름
    screen: Mapped[str] = _text("")
    #: NULL = 바꾼 것 없음, '' = 지우기 요청
    pending_screen: Mapped[str | None] = _text(nullable=True)
    want_plot: Mapped[int | None] = _int(nullable=True)
    pending_name: Mapped[str | None] = _text(nullable=True)
    pending_tagline: Mapped[str | None] = _text(nullable=True)
    pending_sign: Mapped[str | None] = _text(nullable=True)
    consent_at: Mapped[int | None] = _ms(nullable=True)
    review_at: Mapped[int | None] = _ms(nullable=True)
    closed_at: Mapped[int | None] = _ms(nullable=True)
    purged_at: Mapped[int | None] = _ms(nullable=True)
    #: 등록할 때 고른 채널 (NULL = 아무 채널, db.ts v4)
    want_channel: Mapped[int | None] = _int(nullable=True)


class Click(Base):
    """날짜 · 사당별 '서비스 가보기' 클릭 수."""

    __tablename__ = "clicks"

    day: Mapped[str] = mapped_column(Text, primary_key=True)
    slug: Mapped[str] = mapped_column(Text, primary_key=True)
    n: Mapped[int] = _int("0")


class AdminLog(Base):
    """운영자 화면 · 운영 명령에서 한 일. IP는 서버 키로 만든 해시로만 (운영 명령은 'cli')."""

    __tablename__ = "admin_log"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    at: Mapped[int] = _ms()
    action: Mapped[str] = _text()
    target: Mapped[str] = _text("")
    ip_hash: Mapped[str] = _text("")
    detail: Mapped[str] = _text("")


class Block(Base):
    """운영자 차단 · 강퇴. 원래 IP는 두지 않고 서버 키로 만든 IP 키만 기간 동안 둡니다."""

    __tablename__ = "blocks"
    __table_args__ = (CheckConstraint("kind IN ('kick', 'block')", name="kind"), Index("blocks_until", "until"))

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    at: Mapped[int] = _ms()
    until: Mapped[int] = _ms()
    kind: Mapped[str] = _text()
    #: 'k:' + 32자 또는 빈 글자
    ip_key: Mapped[str] = _text("")
    sid: Mapped[str] = _text("")
    nick: Mapped[str] = _text("")
    reason: Mapped[str] = _text("")


class PinLock(Base):
    """프로젝트별 그날 PIN 틀린 횟수와 24시간 잠금 (registry.ts)."""

    __tablename__ = "pin_locks"

    project_id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=False)
    day: Mapped[str] = _text()
    fails: Mapped[int] = _int("0")
    until: Mapped[int] = _ms(default="0")
