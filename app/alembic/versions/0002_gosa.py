"""gosa: 새로 연 사당(첫 주) 앞에 놓는 고사상 물건 (돼지머리 대신, 사당 주인이 고름)

  · projects.gosa  TEXT NULL — 작성자가 등록소에서 고른 것 (NULL = 고르지 않음 → 기본 'cake')
  · shrines.gosa   TEXT NOT NULL DEFAULT 'cake' + CHECK ck_shrines_gosa (cake · wreath · siru · bugeo)
있던 사당은 모두 'cake'가 됩니다. PostgreSQL 11+는 상수 DEFAULT가 붙은 칸 더하기를 표를 다시 쓰지 않고 끝냅니다.
키 목록은 shrine/logic/links.py GOSA_KEYS와 같아야 합니다 (바꾸려면 새 리비전으로).

Revision ID: 0002
Revises: 0001
Create Date: 2026-11-24 00:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0002'
down_revision: str | None = '0001'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('projects', sa.Column('gosa', sa.Text(), nullable=True))
    op.add_column('shrines', sa.Column('gosa', sa.Text(), server_default='cake', nullable=False))
    op.create_check_constraint(op.f('ck_shrines_gosa'), 'shrines', "gosa IN ('cake', 'wreath', 'siru', 'bugeo')")


def downgrade() -> None:
    op.drop_constraint(op.f('ck_shrines_gosa'), 'shrines', type_='check')
    op.drop_column('shrines', 'gosa')
    op.drop_column('projects', 'gosa')
