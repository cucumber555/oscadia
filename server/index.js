import "dotenv/config";

import express from "express";
import cors from "cors";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

import { crawl } from "./crawler.js";

import {
    verifySMTP,
    getMyOSmail,
    createOSmailProfile,
    sendInternalMail,
    sendExternalMail,
    receiveExternalMail,
    getEmails,
    markAsRead,
    deleteEmail,
    restoreEmail
} from "./osmail.js";

import {
    requestLoginCode,
    verifyLoginCode,
    logout as oscaaiLogout,
    chat as oscaaiChat,
    getHistory as getOscaAIHistory,
    getConversation as getOscaAIConversation,
    getHealth as getOscaAIHealth
} from "./oscaai.js";

// ========================================
// 기본 설정
// ========================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const { Pool } = pg;

const app = express();

const PORT = process.env.PORT || 10000;

app.use(cors({
    origin: [
        "https://oscadia.net",
        "https://www.oscadia.net",
        "https://cucumber555.github.io"
    ],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());
// ========================================
// Resend 외부 이메일 수신
// ========================================

app.post(
    "/api/osmail/inbound",
    express.json({
        limit: "20mb"
    }),
    async (req, res) => {

        try {

            const event =
                req.body;

            if(
                event?.type !==
                "email.received"
            ){

                return res.json({
                    ok:true
                });

            }

            const data =
                event.data || {};

            const recipients =
                Array.isArray(data.to)
                    ? data.to
                    : [];

            /*
             * Resend가 webhook에 제공하는
             * email_id를 이용해 실제 메일 내용을
             * API에서 가져온다.
             */

            let text =
                data.text || "";

            let html =
                data.html || "";

            if(
                (!text && !html) &&
                data.email_id &&
                process.env.RESEND_API_KEY
            ){

                const response =
                    await fetch(
                        `https://api.resend.com/emails/${data.email_id}`,
                        {
                            headers:{
                                Authorization:
                                    `Bearer ${process.env.RESEND_API_KEY}`
                            }
                        }
                    );

                if(response.ok){

                    const email =
                        await response.json();

                    text =
                        email.text ||
                        "";

                    html =
                        email.html ||
                        "";

                }

            }

            await receiveExternalMail({

                from:
                    data.from || "",

                to:
                    recipients,

                subject:
                    data.subject || "",

                text,

                html,

                messageId:
                    data.message_id ||
                    data.email_id ||
                    null

            });

            return res.json({
                ok:true
            });

        } catch(error){

            console.error(
                "[OSMAIL INBOUND ERROR]",
                error
            );

            return res.status(500).json({

                ok:false,

                error:
                    error.message

            });

        }

    }
);
app.use(
    express.json({
        limit: "10mb"
    })
);


// ========================================
// PostgreSQL
// ========================================

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    },
    max: 2
});

pool.on("error", error => {
    console.error(
        "[POSTGRES POOL ERROR]",
        error
    );
});


// ========================================
// 서버 상태
// ========================================

let crawlerRunning = false;
let lastCrawlerStart = null;
let lastCrawlerFinish = null;
let lastCrawlerError = null;


// ========================================
// 검색어 별칭
// ========================================

const SEARCH_ALIASES = {
    "구글": ["google", "google.com"],
    "google": ["google", "google.com"],

    "네이버": ["naver", "naver.com"],
    "naver": ["naver", "naver.com"],

    "다음": ["daum", "daum.net"],
    "daum": ["daum", "daum.net"],

    "유튜브": ["youtube", "youtube.com"],
    "youtube": ["youtube", "youtube.com"],

    "깃허브": ["github", "github.com"],
    "github": ["github", "github.com"],

    "위키백과": ["wikipedia", "wikipedia.org"],
    "위키피디아": ["wikipedia", "wikipedia.org"],
    "wikipedia": ["wikipedia", "wikipedia.org"],

    "모질라": ["mozilla", "mozilla.org"],
    "mozilla": ["mozilla", "mozilla.org"],

    "나사": ["nasa", "nasa.gov"],
    "nasa": ["nasa", "nasa.gov"],

    "아마존": ["amazon", "amazon.com"],
    "amazon": ["amazon", "amazon.com"],

    "비비씨": ["bbc", "bbc.com"],
    "bbc": ["bbc", "bbc.com"],

    "씨엔엔": ["cnn", "cnn.com"],
    "cnn": ["cnn", "cnn.com"],

    "레딧": ["reddit", "reddit.com"],
    "reddit": ["reddit", "reddit.com"],

    "스택오버플로": [
        "stackoverflow",
        "stackoverflow.com"
    ],

    "스택오버플로우": [
        "stackoverflow",
        "stackoverflow.com"
    ],

    "stackoverflow": [
        "stackoverflow",
        "stackoverflow.com"
    ],

    "뉴욕타임스": [
        "nytimes",
        "nytimes.com"
    ],

    "뉴욕 타임스": [
        "nytimes",
        "nytimes.com"
    ],

    "nytimes": [
        "nytimes",
        "nytimes.com"
    ],

    "가디언": [
        "guardian",
        "theguardian.com"
    ],

    "guardian": [
        "guardian",
        "theguardian.com"
    ],

    "브리태니커": [
        "britannica",
        "britannica.com"
    ],

    "britannica": [
        "britannica",
        "britannica.com"
    ],

    "인터넷 아카이브": [
        "archive",
        "archive.org"
    ],

    "인터넷아카이브": [
        "archive",
        "archive.org"
    ],

    "archive": [
        "archive",
        "archive.org"
    ],

    "w3c": [
        "w3c",
        "w3.org"
    ],

    "월드와이드웹컨소시엄": [
        "w3c",
        "w3.org"
    ],

    "파이썬": [
        "python",
        "python.org"
    ],

    "python": [
        "python",
        "python.org"
    ],

    "나무위키": [
        "namu",
        "namu.wiki"
    ],

    "namuwiki": [
        "namu",
        "namu.wiki"
    ]
};


// ========================================
// 관련 검색어
// ========================================

const RELATED_TERMS = {
    "검색": [
        "search",
        "검색엔진",
        "search engine",
        "웹검색",
        "web search"
    ],

    "검색엔진": [
        "search",
        "search engine",
        "검색"
    ],

    "동영상": [
        "video",
        "videos",
        "youtube",
        "streaming"
    ],

    "영상": [
        "video",
        "videos",
        "youtube",
        "streaming"
    ],

    "뉴스": [
        "news",
        "breaking news",
        "신문"
    ],

    "쇼핑": [
        "shopping",
        "shop",
        "store",
        "products",
        "상품"
    ],

    "온라인 쇼핑": [
        "shopping",
        "shop",
        "store",
        "products"
    ],

    "백과사전": [
        "encyclopedia",
        "wikipedia",
        "knowledge",
        "reference"
    ],

    "위키": [
        "wiki",
        "wikipedia",
        "encyclopedia"
    ],

    "개발": [
        "developer",
        "development",
        "programming",
        "code",
        "software"
    ],

    "프로그래밍": [
        "programming",
        "developer",
        "code",
        "software"
    ],

    "코딩": [
        "coding",
        "programming",
        "developer",
        "code"
    ],

    "우주": [
        "space",
        "nasa",
        "astronomy",
        "science"
    ],

    "과학": [
        "science",
        "research",
        "technology"
    ],

    "소셜": [
        "social",
        "community",
        "forum",
        "discussion"
    ],

    "커뮤니티": [
        "community",
        "forum",
        "discussion",
        "social"
    ]
};


// ========================================
// 검색 함수
// ========================================

function normalizeSearchQuery(query) {
    return String(query || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
}


function tokenizeQuery(query) {
    return normalizeSearchQuery(query)
        .split(/[\s,./!?()[\]{}:;|]+/)
        .map(word => word.trim())
        .filter(Boolean);
}


function getSearchTerms(query) {
    const normalized = normalizeSearchQuery(query);

    const terms = new Set();

    if (normalized) {
        terms.add(normalized);
    }

    for (const token of tokenizeQuery(normalized)) {
        terms.add(token);
    }

    const aliases = SEARCH_ALIASES[normalized];

    if (aliases) {
        for (const alias of aliases) {
            terms.add(alias.toLowerCase());
        }
    }

    const related = RELATED_TERMS[normalized];

    if (related) {
        for (const term of related) {
            terms.add(term.toLowerCase());
        }
    }

    return [...terms];
}


function getDomainFromUrl(url) {
    try {
        return new URL(url)
            .hostname
            .toLowerCase()
            .replace(/^www\./, "");
    } catch {
        return "";
    }
}


// ========================================
// OSCADIA 검색 API
// ========================================

app.get("/api/search", async (req, res) => {
    const originalQuery = String(
        req.query.q || ""
    ).trim();

    if (!originalQuery) {
        return res.json({
            ok: true,
            count: 0,
            results: []
        });
    }

    const query = normalizeSearchQuery(
        originalQuery
    );

    const terms = getSearchTerms(query).slice(
        0,
        30
    );

    try {
        const conditions = [];
        const values = [];

        for (
            let i = 0;
            i < terms.length;
            i++
        ) {
            const p = `$${i + 1}`;

            values.push(terms[i]);

            conditions.push(`
                (
                    LOWER(COALESCE(title, ''))
                        LIKE '%' || LOWER(${p}) || '%'

                    OR LOWER(COALESCE(description, ''))
                        LIKE '%' || LOWER(${p}) || '%'

                    OR LOWER(COALESCE(keywords, ''))
                        LIKE '%' || LOWER(${p}) || '%'

                    OR LOWER(COALESCE(content, ''))
                        LIKE '%' || LOWER(${p}) || '%'

                    OR LOWER(COALESCE(url, ''))
                        LIKE '%' || LOWER(${p}) || '%'

                    OR LOWER(COALESCE(domain, ''))
                        LIKE '%' || LOWER(${p}) || '%'
                )
            `);
        }

        if (!conditions.length) {
            return res.json({
                ok: true,
                query: originalQuery,
                count: 0,
                results: []
            });
        }

        const scoreParts = terms.map(
            (term, i) => {
                const p = `$${i + 1}`;

                return `
                    (
                        CASE
                            WHEN LOWER(COALESCE(title, ''))
                                LIKE '%' || LOWER(${p}) || '%'
                            THEN 100
                            ELSE 0
                        END

                        +

                        CASE
                            WHEN LOWER(COALESCE(keywords, ''))
                                LIKE '%' || LOWER(${p}) || '%'
                            THEN 60
                            ELSE 0
                        END

                        +

                        CASE
                            WHEN LOWER(COALESCE(description, ''))
                                LIKE '%' || LOWER(${p}) || '%'
                            THEN 45
                            ELSE 0
                        END

                        +

                        CASE
                            WHEN LOWER(COALESCE(domain, ''))
                                LIKE '%' || LOWER(${p}) || '%'
                            THEN 40
                            ELSE 0
                        END

                        +

                        CASE
                            WHEN LOWER(COALESCE(url, ''))
                                LIKE '%' || LOWER(${p}) || '%'
                            THEN 30
                            ELSE 0
                        END

                        +

                        CASE
                            WHEN LOWER(COALESCE(content, ''))
                                LIKE '%' || LOWER(${p}) || '%'
                            THEN 10
                            ELSE 0
                        END
                    )
                `;
            }
        );

        const sql = `
            SELECT
                id,
                url,
                title,
                description,
                domain,
                keywords,
                last_crawled,

                (${scoreParts.join(" + ")})

                    AS relevance_score

            FROM pages

            WHERE
                ${conditions.join(" OR ")}

            ORDER BY
                relevance_score DESC,
                last_crawled DESC

            LIMIT 50
        `;

        const result = await pool.query(
            sql,
            values
        );

        const results = result.rows.map(
            row => {
                const title = String(
                    row.title || ""
                ).toLowerCase();

                const description = String(
                    row.description || ""
                ).toLowerCase();

                const keywords = String(
                    row.keywords || ""
                ).toLowerCase();

                const content = String(
                    row.content || ""
                ).toLowerCase();

                const domain = String(
                    row.domain || ""
                ).toLowerCase();

                const url = String(
                    row.url || ""
                ).toLowerCase();

                let score = Number(
                    row.relevance_score || 0
                );

                if (title.includes(query)) {
                    score += 250;
                }

                if (keywords.includes(query)) {
                    score += 150;
                }

                if (description.includes(query)) {
                    score += 100;
                }

                let aliasMatch = false;

                const aliases =
                    SEARCH_ALIASES[query];

                if (aliases) {
                    aliasMatch = aliases.some(
                        alias => {
                            const a =
                                alias.toLowerCase();

                            return (
                                domain.includes(a) ||
                                url.includes(a) ||
                                title.includes(a) ||
                                keywords.includes(a)
                            );
                        }
                    );

                    if (aliasMatch) {
                        score += 500;
                    }
                }

                let relatedMatch = false;

                const related =
                    RELATED_TERMS[query];

                if (related) {
                    relatedMatch = related.some(
                        term => {
                            const t =
                                term.toLowerCase();

                            return (
                                keywords.includes(t) ||
                                title.includes(t) ||
                                description.includes(t) ||
                                content.includes(t)
                            );
                        }
                    );

                    if (relatedMatch) {
                        score += 180;
                    }
                }

                return {
                    id: row.id,

                    url: row.url,

                    title:
                        row.title ||
                        "제목 없음",

                    description:
                        row.description ||
                        "",

                    domain:
                        row.domain ||
                        getDomainFromUrl(row.url),

                    keywords:
                        row.keywords ||
                        "",

                    last_crawled:
                        row.last_crawled,

                    rank: score,

                    alias_match:
                        aliasMatch,

                    related_match:
                        relatedMatch
                };
            }
        );

        results.sort((a, b) => {
            if (
                a.alias_match !==
                b.alias_match
            ) {
                return a.alias_match
                    ? -1
                    : 1;
            }

            if (
                a.related_match !==
                b.related_match
            ) {
                return a.related_match
                    ? -1
                    : 1;
            }

            return (
                Number(b.rank) -
                Number(a.rank)
            );
        });

        const uniqueResults = [];
        const seenUrls = new Set();

        for (const result of results) {
            const normalizedUrl = String(
                result.url || ""
            )
                .toLowerCase()
                .replace(/\/+$/, "");

            if (
                seenUrls.has(
                    normalizedUrl
                )
            ) {
                continue;
            }

            seenUrls.add(
                normalizedUrl
            );

            uniqueResults.push(result);

            if (
                uniqueResults.length >= 50
            ) {
                break;
            }
        }

        return res.json({
            ok: true,
            query: originalQuery,
            searchTerms: terms,
            count: uniqueResults.length,
            results: uniqueResults
        });

    } catch (error) {
        console.error(
            "[SEARCH ERROR]",
            error
        );

        return res.status(500).json({
            ok: false,
            error:
                "검색 중 오류가 발생했습니다."
        });
    }
});


// ========================================
// OscaTranslate
// ========================================

const TRANSLATE_API_URL =
    "https://api.mymemory.translated.net/get";

const GOOGLE_TRANSLATE_API_URL =
    "https://translate.googleapis.com/translate_a/single";

const SUPPORTED_TRANSLATE_LANGUAGES =
    new Set([
        "auto",
        "ko",
        "en",
        "ja",
        "zh",
        "de",
        "fr",
        "es",
        "it",
        "pt",
        "ru"
    ]);


function isSupportedTranslateLanguage(
    language
) {
    return SUPPORTED_TRANSLATE_LANGUAGES.has(
        String(language || "")
            .toLowerCase()
    );
}


// ========================================
// 언어 자동 감지
// ========================================

function detectLanguage(text) {
    const value = String(text || "")
        .trim();

    if (!value) {
        return "en";
    }

    if (/[\uAC00-\uD7A3]/.test(value)) {
        return "ko";
    }

    if (/[\u3040-\u30FF]/.test(value)) {
        return "ja";
    }

    if (/[\u4E00-\u9FFF]/.test(value)) {
        return "zh";
    }

    if (/[\u0400-\u04FF]/.test(value)) {
        return "ru";
    }

    return "en";
}


// ========================================
// 긴 문장 분할
// ========================================

function splitTextByBytes(
    text,
    maxBytes = 450
) {
    const chunks = [];

    let current = "";
    let currentBytes = 0;

    for (const char of text) {
        const charBytes =
            Buffer.byteLength(
                char,
                "utf8"
            );

        if (
            current &&
            currentBytes + charBytes >
            maxBytes
        ) {
            chunks.push(current);

            current = "";
            currentBytes = 0;
        }

        current += char;
        currentBytes += charBytes;
    }

    if (current) {
        chunks.push(current);
    }

    return chunks;
}


// ========================================
// HTML entity 디코딩
// ========================================

function decodeHtmlEntities(text) {
    return String(text || "")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}


// ========================================
// MyMemory 번역
// ========================================

async function translateChunk(
    text,
    source,
    target
) {
    const params =
        new URLSearchParams();

    params.set("q", text);

    params.set(
        "langpair",
        `${source}|${target}`
    );

    params.set("mt", "1");

    const url =
        `${TRANSLATE_API_URL}?${params.toString()}`;

    const response = await fetch(
        url,
        {
            method: "GET",

            headers: {
                Accept:
                    "application/json",

                "User-Agent":
                    "OSCADIA-OscaTranslate/1.0"
            },

            signal:
                AbortSignal.timeout(
                    30000
                )
        }
    );

    if (!response.ok) {
        throw new Error(
            `번역 제공 서버 HTTP ${response.status}`
        );
    }

    const rawBuffer =
        await response.arrayBuffer();

    const rawText =
        new TextDecoder("utf-8").decode(
            rawBuffer
        );

    let data;

    try {
        data = JSON.parse(rawText);
    } catch {
        throw new Error(
            "번역 서버가 올바른 JSON을 반환하지 않았습니다."
        );
    }

    if (
        !data ||
        !data.responseData ||
        typeof data.responseData
            .translatedText !==
            "string"
    ) {
        throw new Error(
            "번역 결과가 올바르지 않습니다."
        );
    }

    const translated =
        decodeHtmlEntities(
            data.responseData
                .translatedText
        ).trim();

    if (!translated) {
        throw new Error(
            "MyMemory가 정상적인 번역 결과를 반환하지 않았습니다."
        );
    }

    return translated;
}


// ========================================
// Google 공개 번역 fallback
// ========================================

async function translateWithGoogle(
    text,
    source,
    target
) {
    const googleUrl =
        `${GOOGLE_TRANSLATE_API_URL}?` +
        new URLSearchParams({
            client: "gtx",
            sl: source,
            tl: target,
            dt: "t",
            q: text
        }).toString();

    const googleResponse =
        await fetch(
            googleUrl,
            {
                method: "GET",

                headers: {
                    "User-Agent":
                        "OSCADIA-OscaTranslate/1.0"
                },

                signal:
                    AbortSignal.timeout(
                        30000
                    )
            }
        );

    if (!googleResponse.ok) {
        throw new Error(
            `번역 제공 서버 HTTP ${googleResponse.status}`
        );
    }

    const googleData =
        await googleResponse.json();

    const translated =
        Array.isArray(googleData?.[0])
            ? googleData[0]
                .map(
                    part =>
                        part?.[0] || ""
                )
                .join("")
            : "";

    if (!translated) {
        throw new Error(
            "Google 번역 결과가 비어 있습니다."
        );
    }

    return translated;
}


// ========================================
// 번역 서버 상태
// ========================================

app.get(
    "/api/translate/health",
    (req, res) => {
        return res.json({
            ok: true,
            service: "OscaTranslate",
            provider:
                "MyMemory / Google fallback",
            configured: true,
            free: true
        });
    }
);


// ========================================
// 지원 언어
// ========================================

app.get(
    "/api/translate/languages",
    (req, res) => {
        return res.json({
            ok: true,

            languages: [
                {
                    code: "auto",
                    name: "자동 감지"
                },
                {
                    code: "ko",
                    name: "한국어"
                },
                {
                    code: "en",
                    name: "English"
                },
                {
                    code: "ja",
                    name: "日本語"
                },
                {
                    code: "zh",
                    name: "中文"
                },
                {
                    code: "de",
                    name: "Deutsch"
                },
                {
                    code: "fr",
                    name: "Français"
                },
                {
                    code: "es",
                    name: "Español"
                },
                {
                    code: "it",
                    name: "Italiano"
                },
                {
                    code: "pt",
                    name: "Português"
                },
                {
                    code: "ru",
                    name: "Русский"
                }
            ]
        });
    }
);


// ========================================
// 실제 번역
// ========================================

app.post(
    "/api/translate",
    async (req, res) => {
        try {
            let {
                q,
                source,
                target
            } = req.body || {};

            q = String(q || "").trim();

            source =
                String(
                    source || "auto"
                )
                    .trim()
                    .toLowerCase();

            target =
                String(target || "")
                    .trim()
                    .toLowerCase();

            if (!q) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "번역할 텍스트를 입력하세요."
                });
            }

            if (q.length > 5000) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "번역할 텍스트는 5000자 이하로 입력하세요."
                });
            }

            if (!target) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "번역 대상 언어가 필요합니다."
                });
            }

            if (
                !isSupportedTranslateLanguage(
                    source
                )
            ) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "지원하지 않는 원본 언어입니다."
                });
            }

            if (
                !isSupportedTranslateLanguage(
                    target
                )
            ) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "지원하지 않는 번역 언어입니다."
                });
            }

            if (target === "auto") {
                return res.status(400).json({
                    ok: false,
                    error:
                        "번역 대상 언어에는 자동 감지를 사용할 수 없습니다."
                });
            }

            if (source === "auto") {
                source = detectLanguage(q);
            }

            if (source === target) {
                return res.json({
                    ok: true,
                    translatedText: q,
                    source,
                    target,
                    provider:
                        "same-language"
                });
            }

            console.log(
                `[TRANSLATE] ${source} -> ${target}, ${q.length} chars`
            );

            const chunks =
                splitTextByBytes(
                    q,
                    450
                );

            const translatedChunks = [];

            for (const chunk of chunks) {
                let translated;

                try {
                    translated =
                        await translateChunk(
                            chunk,
                            source,
                            target
                        );

                } catch (
                    myMemoryError
                ) {
                    console.warn(
                        "[TRANSLATE] MyMemory 실패, Google 공개 엔드포인트로 재시도:",
                        myMemoryError.message
                    );

                    translated =
                        await translateWithGoogle(
                            chunk,
                            source,
                            target
                        );
                }

                translatedChunks.push(
                    translated
                );
            }

            const translatedText =
                translatedChunks.join("");

            if (!translatedText) {
                return res.status(502).json({
                    ok: false,
                    error:
                        "번역 결과가 비어 있습니다."
                });
            }

            return res.json({
                ok: true,
                translatedText,
                source,
                target,
                provider:
                    "MyMemory / Google fallback"
            });

        } catch (error) {
            console.error(
                "[TRANSLATE ERROR]",
                error
            );

            if (
                error?.name ===
                "TimeoutError"
            ) {
                return res.status(504).json({
                    ok: false,
                    error:
                        "번역 서버 응답 시간이 초과되었습니다."
                });
            }

            return res.status(502).json({
                ok: false,
                error:
                    error?.message ||
                    "번역 서버에 연결할 수 없습니다."
            });
        }
    }
);


// ========================================
// Health Check
// ========================================

app.get(
    "/api/health",
    async (req, res) => {
        try {
            await pool.query("SELECT 1");

            return res.json({
                ok: true,
                database: "connected",
                crawler: "enabled",
                translate: "enabled",
                oscaai: "enabled",
                osmail: "enabled",
                service: "OSCADIA"
            });

        } catch (error) {
            console.error(
                "[HEALTH ERROR]",
                error
            );

            return res.status(500).json({
                ok: false,
                database: "disconnected",
                error: error.message
            });
        }
    }
);


// ========================================
// Crawler
// ========================================

async function runCrawler() {
    if (crawlerRunning) {
        console.log(
            "[CRAWLER] Already running. Skip."
        );

        return;
    }

    crawlerRunning = true;

    lastCrawlerStart =
        new Date().toISOString();

    lastCrawlerError = null;

    console.log(
        "[CRAWLER] Automatic crawl started."
    );

    try {
        await crawl();

        lastCrawlerFinish =
            new Date().toISOString();

        console.log(
            "[CRAWLER] Automatic crawl finished."
        );

    } catch (error) {
        lastCrawlerError =
            error?.message ||
            String(error);

        console.error(
            "[CRAWLER ERROR]",
            error
        );

    } finally {
        crawlerRunning = false;
    }
}


// ========================================
// Crawler 상태
// ========================================

app.get(
    "/api/crawler",
    (req, res) => {
        return res.json({
            enabled: true,
            running: crawlerRunning,
            lastStart:
                lastCrawlerStart,
            lastFinish:
                lastCrawlerFinish,
            lastError:
                lastCrawlerError
        });
    }
);


// ========================================
// 사용자 URL 크롤링 큐
// ========================================

app.post(
    "/api/crawl/queue",
    async (req, res) => {
        try {
            let { url } =
                req.body || {};

            if (
                !url ||
                typeof url !==
                    "string"
            ) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "URL을 입력하세요."
                });
            }

            url = url.trim();

            if (
                !/^https?:\/\//i.test(
                    url
                )
            ) {
                url = `https://${url}`;
            }

            let parsed;

            try {
                parsed = new URL(url);
            } catch {
                return res.status(400).json({
                    ok: false,
                    error:
                        "올바른 URL이 아닙니다."
                });
            }

            if (
                parsed.protocol !==
                    "http:" &&
                parsed.protocol !==
                    "https:"
            ) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "HTTP 또는 HTTPS 주소만 사용할 수 있습니다."
                });
            }

            if (
                parsed.username ||
                parsed.password
            ) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "사용자명 또는 비밀번호가 포함된 URL은 사용할 수 없습니다."
                });
            }

            parsed.hash = "";

            if (
                (
                    parsed.protocol ===
                        "http:" &&
                    parsed.port ===
                        "80"
                ) ||
                (
                    parsed.protocol ===
                        "https:" &&
                    parsed.port ===
                        "443"
                )
            ) {
                parsed.port = "";
            }

            url = parsed.href;

            const existing =
                await pool.query(
                    `
                    SELECT url
                    FROM pages
                    WHERE url = $1
                    LIMIT 1
                    `,
                    [url]
                );

            if (
                existing.rows.length >
                0
            ) {
                return res.json({
                    ok: true,
                    queued: false,
                    alreadyIndexed:
                        true,
                    url
                });
            }

            const result =
                await pool.query(
                    `
                    INSERT INTO crawl_queue
                    (
                        url,
                        status
                    )
                    VALUES
                    (
                        $1,
                        'pending'
                    )
                    ON CONFLICT (url)
                    DO UPDATE SET
                        status = 'pending',
                        last_error = NULL,
                        finished_at = NULL
                    RETURNING *
                    `,
                    [url]
                );

            console.log(
                "[CRAWL QUEUE] Added:",
                url
            );

            setTimeout(() => {
                runCrawler()
                    .catch(error => {
                        console.error(
                            "[QUEUE CRAWLER ERROR]",
                            error
                        );
                    });
            }, 100);

            return res.json({
                ok: true,
                queued: true,
                url,
                queue:
                    result.rows[0]
            });

        } catch (error) {
            console.error(
                "[CRAWL QUEUE ERROR]",
                error
            );

            return res.status(500).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// Crawler 큐 목록
// ========================================

app.get(
    "/api/crawl/queue",
    async (req, res) => {
        try {
            const result =
                await pool.query(
                    `
                    SELECT
                        id,
                        url,
                        status,
                        attempts,
                        added_at,
                        started_at,
                        finished_at,
                        last_error
                    FROM crawl_queue
                    ORDER BY added_at DESC
                    LIMIT 100
                    `
                );

            return res.json({
                ok: true,
                count:
                    result.rows.length,
                queue:
                    result.rows
            });

        } catch (error) {
            console.error(
                "[CRAWL QUEUE GET ERROR]",
                error
            );

            return res.status(500).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// OSmail API
// ========================================

app.get(
    "/api/osmail/me",
    async (req, res) => {
        try {
            const result =
                await getMyOSmail(req);

            return res.json({
                ok: true,
                ...result
            });

        } catch (error) {
            console.error(
                "[OSMAIL ME ERROR]",
                error
            );

            return res.status(401).json({
                ok: false,
                error:
                    error.message ||
                    "로그인이 필요합니다."
            });
        }
    }
);


// ========================================
// OSmail ID 생성
// ========================================

app.post(
    "/api/osmail/profile",
    async (req, res) => {
        try {
            const {
                osmailId,
                displayName
            } = req.body || {};

            if (!osmailId) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "OSmail ID를 입력하세요."
                });
            }

            const result =
                await createOSmailProfile(
                    req,
                    osmailId,
                    displayName
                );

            return res.json({
                ok: true,
                ...result
            });

        } catch (error) {
            console.error(
                "[OSMAIL PROFILE ERROR]",
                error
            );

            return res.status(400).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// 메일 목록
// ========================================

app.get(
    "/api/osmail/emails",
    async (req, res) => {
        try {
            const emails =
                await getEmails(req);

            return res.json({
                ok: true,
                emails
            });

        } catch (error) {
            console.error(
                "[OSMAIL EMAILS ERROR]",
                error
            );

            return res.status(401).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// OSmail 내부 메일
// ========================================

app.post(
    "/api/osmail/send-internal",
    async (req, res) => {
        try {
            const {
                to,
                subject,
                body
            } = req.body || {};

            if (!to) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "받는 사람을 입력하세요."
                });
            }

            const email =
                await sendInternalMail(
                    req,
                    {
                        to,
                        subject:
                            subject || "",
                        body:
                            body || ""
                    }
                );

            return res.json({
                ok: true,
                email
            });

        } catch (error) {
            console.error(
                "[OSMAIL INTERNAL SEND ERROR]",
                error
            );

            return res.status(400).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// 외부 이메일
// ========================================

app.post(
    "/api/osmail/send-external",
    async (req, res) => {
        try {
            const {
                to,
                subject,
                body
            } = req.body || {};

            console.log("[OSMAIL REQUEST]", {
                to,
                subject,
                body
            });

            if (!to) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "받는 사람을 입력하세요."
                });
            }

            const result =
                await sendExternalMail(
                    req,
                    {
                        to,
                        subject:
                            subject || "",
                        body:
                            body || ""
                    }
                );

            return res.json({
                ok: true,
                ...result
            });

        } catch (error) {
            console.error(
                "[OSMAIL EXTERNAL SEND ERROR]",
                error
            );

            return res.status(400).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// 읽음 처리
// ========================================

app.post(
    "/api/osmail/read",
    async (req, res) => {
        try {
            if (!req.body?.id) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "메일 ID가 필요합니다."
                });
            }

            const email =
                await markAsRead(
                    req,
                    req.body.id
                );

            return res.json({
                ok: true,
                email
            });

        } catch (error) {
            console.error(
                "[OSMAIL READ ERROR]",
                error
            );

            return res.status(400).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// 삭제
// ========================================

app.post(
    "/api/osmail/delete",
    async (req, res) => {
        try {
            if (!req.body?.id) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "메일 ID가 필요합니다."
                });
            }

            const email =
                await deleteEmail(
                    req,
                    req.body.id
                );

            return res.json({
                ok: true,
                email
            });

        } catch (error) {
            console.error(
                "[OSMAIL DELETE ERROR]",
                error
            );

            return res.status(400).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// 복구
// ========================================

app.post(
    "/api/osmail/restore",
    async (req, res) => {
        try {
            if (!req.body?.id) {
                return res.status(400).json({
                    ok: false,
                    error:
                        "메일 ID가 필요합니다."
                });
            }

            const email =
                await restoreEmail(
                    req,
                    req.body.id
                );

            return res.json({
                ok: true,
                email
            });

        } catch (error) {
            console.error(
                "[OSMAIL RESTORE ERROR]",
                error
            );

            return res.status(400).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// SMTP 상태 확인
// ========================================

app.get(
    "/api/osmail/test",
    async (req, res) => {
        try {
            const ok =
                await verifySMTP();

            return res.json({
                ok,
                service:
                    "OSmail SMTP"
            });

        } catch (error) {
            console.error(
                "[OSMAIL SMTP TEST ERROR]",
                error
            );

            return res.status(500).json({
                ok: false,
                service:
                    "OSmail SMTP",
                error:
                    error.message
            });
        }
    }
);


// ========================================
// OscaAI Health
// ========================================

app.get(
    "/api/oscaai/health",
    (req, res) => {
        return res.json(
            getOscaAIHealth()
        );
    }
);


// ========================================
// OscaAI 비밀번호 설정
// ========================================

app.post(
    "/api/oscaai/password/set",
    async (req, res) => {
        try {
            const result =
                await setPassword(
                    req,
                    req.body?.password
                );

            return res.json(result);

        } catch (error) {
            console.error(
                "[OSCAAI PASSWORD ERROR]",
                error
            );

            return res.status(400).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// OscaAI 로그인 코드 요청
// ========================================

app.post(
    "/api/oscaai/auth/request-code",
    async (req, res) => {
        try {
            const result =
                await requestLoginCode(
                    req.body?.osmailId,
                    req.body?.password
                );

            return res.json(result);

        } catch (error) {
            console.error(
                "[OSCAAI REQUEST CODE ERROR]",
                error
            );

            return res.status(400).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// OscaAI 인증 코드 확인
// ========================================

app.post(
    "/api/oscaai/auth/verify-code",
    async (req, res) => {
        try {
            const result =
                await verifyLoginCode(
                    req.body?.requestId,
                    req.body?.code
                );

            return res.json(result);

        } catch (error) {
            console.error(
                "[OSCAAI VERIFY ERROR]",
                error
            );

            return res.status(400).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// OscaAI 로그아웃
// ========================================

app.post(
    "/api/oscaai/auth/logout",
    async (req, res) => {
        try {
            const result =
                await oscaaiLogout(req);

            return res.json(result);

        } catch (error) {
            console.error(
                "[OSCAAI LOGOUT ERROR]",
                error
            );

            return res.status(400).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// OscaAI 채팅
// ========================================

app.post(
    "/api/oscaai/chat",
    async (req, res) => {
        try {
            const result =
                await oscaaiChat(
                    req,
                    {
                        message:
                            req.body?.message,

                        conversationId:
                            req.body?.conversationId,

                        guestHistory:
                            req.body?.guestHistory
                    }
                );

            return res.json(result);

        } catch (error) {
            console.error(
                "[OSCAAI CHAT ERROR]",
                error
            );

            return res.status(500).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// OscaAI 대화 목록
// ========================================

app.get(
    "/api/oscaai/history",
    async (req, res) => {
        try {
            const conversations =
                await getOscaAIHistory(req);

            return res.json({
                ok: true,
                conversations
            });

        } catch (error) {
            console.error(
                "[OSCAAI HISTORY ERROR]",
                error
            );

            return res.status(401).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// OscaAI 특정 대화
// ========================================

app.get(
    "/api/oscaai/history/:id",
    async (req, res) => {
        try {
            const result =
                await getOscaAIConversation(
                    req,
                    req.params.id
                );

            return res.json({
                ok: true,
                ...result
            });

        } catch (error) {
            console.error(
                "[OSCAAI CONVERSATION ERROR]",
                error
            );

            return res.status(401).json({
                ok: false,
                error:
                    error.message
            });
        }
    }
);


// ========================================
// public 파일
// ========================================

app.use(
    express.static(
        path.join(
            __dirname,
            "../public"
        )
    )
);


// ========================================
// 기본 페이지
// ========================================

app.get(
    "/",
    (req, res) => {
        return res.sendFile(
            path.join(
                __dirname,
                "../public/oscadia.html"
            )
        );
    }
);


// ========================================
// 존재하지 않는 API 처리
// ========================================

app.use(
    "/api",
    (req, res) => {
        return res.status(404).json({
            ok: false,
            error:
                "API endpoint not found",
            path:
                req.path
        });
    }
);


// ========================================
// 서버 시작
// ========================================

async function startServer() {
    try {
        await pool.query(
            "SELECT 1"
        );

        console.log(
            "[DATABASE] PostgreSQL connected."
        );

    } catch (error) {
        console.error(
            "[DATABASE STARTUP ERROR]",
            error.message
        );
    }

    try {
        await verifySMTP();

        console.log(
            "[SMTP] SMTP connection verified."
        );

    } catch (error) {
        console.error(
            "[SMTP STARTUP ERROR]",
            error.message
        );
    }

    app.listen(
        PORT,
        () => {
            console.log(
                `OSCADIA running on port ${PORT}`
            );

            console.log(
                "OSmail API: /api/osmail/me"
            );

            console.log(
                "OscaAI API: /api/oscaai/chat"
            );

            console.log(
                "OscaTranslate API: /api/translate"
            );

            console.log(
                `Translation provider: ${TRANSLATE_API_URL}`
            );

            console.log(
                "Translation API key: not required"
            );


            // ========================================
            // 서버 시작 5초 후 크롤링
            // ========================================

            setTimeout(() => {
                runCrawler()
                    .catch(error => {
                        console.error(
                            "[STARTUP CRAWLER ERROR]",
                            error
                        );
                    });
            }, 5000);


            // ========================================
            // 30분마다 자동 크롤링
            // ========================================

            setInterval(() => {
                runCrawler()
                    .catch(error => {
                        console.error(
                            "[INTERVAL CRAWLER ERROR]",
                            error
                        );
                    });
            }, 30 * 60 * 1000);
        }
    );
}


startServer();