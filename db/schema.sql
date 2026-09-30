CREATE TABLE IF NOT EXISTS pages (
    id BIGSERIAL PRIMARY KEY,

    url TEXT NOT NULL UNIQUE,

    title TEXT NOT NULL DEFAULT '',

    description TEXT NOT NULL DEFAULT '',

    content TEXT NOT NULL DEFAULT '',

    domain TEXT NOT NULL DEFAULT '',

    last_crawled TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pages_title_idx
ON pages
USING GIN (to_tsvector('simple', title));

CREATE INDEX IF NOT EXISTS pages_content_idx
ON pages
USING GIN (to_tsvector('simple', content));

CREATE INDEX IF NOT EXISTS pages_domain_idx
ON pages(domain);