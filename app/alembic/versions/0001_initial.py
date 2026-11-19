"""initial: Node(SQLite) 스키마 v4와 같은 표 10개 (빈 DB에서 시작, 데이터 이전 없음)

server/db.ts 마이그레이션 v1~v4(채널별 사당 포함)와 registry.ts의 pin_locks를 합친 모양입니다.
표 정의의 근거는 shrine/db/models.py에 있습니다. 이미 배포한 리비전은 고치지 않고 새 리비전을 덧붙입니다.

Revision ID: 0001
Revises: 
Create Date: 2026-11-19 00:04:07.044316
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0001'
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('admin_log',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('at', sa.BigInteger(), nullable=False),
    sa.Column('action', sa.Text(), nullable=False),
    sa.Column('target', sa.Text(), server_default='', nullable=False),
    sa.Column('ip_hash', sa.Text(), server_default='', nullable=False),
    sa.Column('detail', sa.Text(), server_default='', nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_admin_log'))
    )
    op.create_table('ai_prayers',
    sa.Column('day', sa.Text(), nullable=False),
    sa.Column('ai', sa.Text(), nullable=False),
    sa.Column('n', sa.Integer(), server_default='0', nullable=False),
    sa.PrimaryKeyConstraint('day', 'ai', name=op.f('pk_ai_prayers'))
    )
    op.create_table('blocks',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('at', sa.BigInteger(), nullable=False),
    sa.Column('until', sa.BigInteger(), nullable=False),
    sa.Column('kind', sa.Text(), nullable=False),
    sa.Column('ip_key', sa.Text(), server_default='', nullable=False),
    sa.Column('sid', sa.Text(), server_default='', nullable=False),
    sa.Column('nick', sa.Text(), server_default='', nullable=False),
    sa.Column('reason', sa.Text(), server_default='', nullable=False),
    sa.CheckConstraint("kind IN ('kick', 'block')", name=op.f('ck_blocks_kind')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_blocks'))
    )
    op.create_index('blocks_until', 'blocks', ['until'], unique=False)
    op.create_table('candles',
    sa.Column('day', sa.Text(), nullable=False),
    sa.Column('slug', sa.Text(), nullable=False),
    sa.Column('prayer', sa.Text(), nullable=False),
    sa.Column('n', sa.Integer(), server_default='0', nullable=False),
    sa.PrimaryKeyConstraint('day', 'slug', 'prayer', name=op.f('pk_candles'))
    )
    op.create_table('clicks',
    sa.Column('day', sa.Text(), nullable=False),
    sa.Column('slug', sa.Text(), nullable=False),
    sa.Column('n', sa.Integer(), server_default='0', nullable=False),
    sa.PrimaryKeyConstraint('day', 'slug', name=op.f('pk_clicks'))
    )
    op.create_table('pin_locks',
    sa.Column('project_id', sa.BigInteger(), autoincrement=False, nullable=False),
    sa.Column('day', sa.Text(), nullable=False),
    sa.Column('fails', sa.Integer(), server_default='0', nullable=False),
    sa.Column('until', sa.BigInteger(), server_default='0', nullable=False),
    sa.PrimaryKeyConstraint('project_id', name=op.f('pk_pin_locks'))
    )
    op.create_table('post_reports',
    sa.Column('post_id', sa.BigInteger(), nullable=False),
    sa.Column('reporter', sa.Text(), nullable=False),
    sa.PrimaryKeyConstraint('post_id', 'reporter', name=op.f('pk_post_reports'))
    )
    op.create_table('posts',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('at', sa.BigInteger(), nullable=False),
    sa.Column('topic', sa.Text(), nullable=False),
    sa.Column('text', sa.Text(), nullable=False),
    sa.Column('nick', sa.Text(), nullable=False),
    sa.Column('hidden', sa.Integer(), server_default='0', nullable=False),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_posts'))
    )
    op.create_index('posts_at', 'posts', ['at'], unique=False)
    op.create_table('projects',
    sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
    sa.Column('code', sa.Text(), nullable=False),
    sa.Column('at', sa.BigInteger(), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('tagline', sa.Text(), nullable=False),
    sa.Column('category', sa.Text(), nullable=False),
    sa.Column('github', sa.Text(), server_default='', nullable=False),
    sa.Column('url', sa.Text(), server_default='', nullable=False),
    sa.Column('email', sa.Text(), nullable=False),
    sa.Column('email_public', sa.Integer(), server_default='0', nullable=False),
    sa.Column('pin_hash', sa.Text(), nullable=False),
    sa.Column('nick', sa.Text(), nullable=False),
    sa.Column('status', sa.Text(), server_default='pending', nullable=False),
    sa.Column('note', sa.Text(), server_default='', nullable=False),
    sa.Column('slug', sa.Text(), server_default='', nullable=False),
    sa.Column('pending_github', sa.Text(), nullable=True),
    sa.Column('pending_url', sa.Text(), nullable=True),
    sa.Column('repo_ok', sa.Integer(), server_default='0', nullable=False),
    sa.Column('stars', sa.Integer(), server_default='0', nullable=False),
    sa.Column('sign', sa.Text(), server_default='', nullable=False),
    sa.Column('screen', sa.Text(), server_default='', nullable=False),
    sa.Column('pending_screen', sa.Text(), nullable=True),
    sa.Column('want_plot', sa.Integer(), nullable=True),
    sa.Column('pending_name', sa.Text(), nullable=True),
    sa.Column('pending_tagline', sa.Text(), nullable=True),
    sa.Column('pending_sign', sa.Text(), nullable=True),
    sa.Column('consent_at', sa.BigInteger(), nullable=True),
    sa.Column('review_at', sa.BigInteger(), nullable=True),
    sa.Column('closed_at', sa.BigInteger(), nullable=True),
    sa.Column('purged_at', sa.BigInteger(), nullable=True),
    sa.Column('want_channel', sa.Integer(), nullable=True),
    sa.CheckConstraint("status IN ('pending', 'approved', 'rejected', 'withdrawn')", name=op.f('ck_projects_status')),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_projects')),
    sa.UniqueConstraint('code', name=op.f('uq_projects_code'))
    )
    op.create_table('shrines',
    sa.Column('slug', sa.Text(), nullable=False),
    sa.Column('name', sa.Text(), nullable=False),
    sa.Column('tagline', sa.Text(), nullable=False),
    sa.Column('category', sa.Text(), nullable=False),
    sa.Column('domain', sa.Text(), nullable=False),
    sa.Column('url', sa.Text(), nullable=False),
    sa.Column('operator', sa.Text(), nullable=False),
    sa.Column('keeper', sa.Integer(), server_default='0', nullable=False),
    sa.Column('paid', sa.Integer(), server_default='0', nullable=False),
    sa.Column('verified_domain', sa.Text(), nullable=False),
    sa.Column('verified_business', sa.Text(), nullable=True),
    sa.Column('joined_at', sa.Text(), nullable=False),
    sa.Column('status', sa.Text(), nullable=False),
    sa.Column('prayer', sa.Text(), nullable=False),
    sa.Column('charm', sa.Text(), nullable=True),
    sa.Column('deco', sa.Text(), server_default='[]', nullable=False),
    sa.Column('screens', sa.Text(), server_default='[]', nullable=False),
    sa.Column('captured_at', sa.Text(), nullable=False),
    sa.Column('channel', sa.Integer(), server_default='1', nullable=False),
    sa.Column('plot', sa.Integer(), nullable=False),
    sa.Column('repo', sa.Text(), server_default='', nullable=False),
    sa.Column('email', sa.Text(), server_default='', nullable=False),
    sa.Column('email_public', sa.Integer(), server_default='0', nullable=False),
    sa.Column('project_id', sa.BigInteger(), server_default='0', nullable=False),
    sa.Column('sign', sa.Text(), server_default='', nullable=False),
    sa.CheckConstraint("status IN ('live', 'check')", name=op.f('ck_shrines_status')),
    sa.PrimaryKeyConstraint('slug', name=op.f('pk_shrines')),
    sa.UniqueConstraint('channel', 'plot', name=op.f('uq_shrines_channel_plot')),
    sa.UniqueConstraint('domain', name=op.f('uq_shrines_domain'))
    )


def downgrade() -> None:
    op.drop_table('shrines')
    op.drop_table('projects')
    op.drop_index('posts_at', table_name='posts')
    op.drop_table('posts')
    op.drop_table('post_reports')
    op.drop_table('pin_locks')
    op.drop_table('clicks')
    op.drop_table('candles')
    op.drop_index('blocks_until', table_name='blocks')
    op.drop_table('blocks')
    op.drop_table('ai_prayers')
    op.drop_table('admin_log')
