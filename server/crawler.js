import "dotenv/config";

import pg from "pg";

import * as cheerio from "cheerio";

import robotsParser from "robots-parser";

const { Pool } = pg;


// ========================================
// PostgreSQL
// ========================================

const pool = new Pool({

    connectionString:
        process.env.DATABASE_URL,

    ssl: {
        rejectUnauthorized: false
    },

    max: 2
});


// ========================================
// 설정
// ========================================

const MAX_PAGES = 2000;

const MAX_DEPTH = 3;

const REQUEST_DELAY = 1200;

const REQUEST_TIMEOUT = 10000;

const MAX_CONTENT = 100000;

// sitemap에서 도메인별로 가져올 최대 URL
const MAX_SITEMAP_URLS_PER_DOMAIN = 300;

// 메모리 큐 최대 크기
const MAX_QUEUE_SIZE =
    MAX_PAGES * 3;

// 사용자 큐에서 한 번에 가져올 최대 개수
const MAX_USER_QUEUE = 500;


// ========================================
// 시작 사이트
// ========================================

const SEED_URLS = [

    "https://www.wikipedia.org/",

    "https://github.com/",

    "https://www.mozilla.org/",

    "https://www.nasa.gov/",

    "https://www.youtube.com/",

    "https://www.amazon.com/",

    "https://www.nationalgeographic.com/",

    "https://www.naver.com/",

    "https://www.google.com/",

    "https://www.bbc.com/",

    "https://www.cnn.com/",

    "https://www.reddit.com/",

    "https://stackoverflow.com/",

    "https://www.nytimes.com/",

    "https://www.theguardian.com/",

    "https://www.britannica.com/",

    "https://www.archive.org/",

    "https://www.w3.org/",

    "https://www.python.org/",

    "https://www.namu.wiki/",

    "https://www.daum.net/"

];


// ========================================
// 사용자 요청 크롤링 큐
// ========================================

async function getUserCrawlQueue() {

    const result = await pool.query(`

        SELECT

            id,

            url,

            attempts

        FROM crawl_queue

        WHERE status = 'pending'

        ORDER BY added_at ASC

        LIMIT $1

    `, [
        MAX_USER_QUEUE
    ]);

    return result.rows;
}


// ========================================
// 큐 항목 크롤링 시작 표시
// ========================================

async function markQueueStarted(id) {

    await pool.query(`

        UPDATE crawl_queue

        SET

            status = 'crawling',

            attempts = attempts + 1,

            started_at = NOW(),

            last_error = NULL

        WHERE id = $1

    `, [
        id
    ]);
}


// ========================================
// 큐 항목 완료
// ========================================

async function markQueueFinished(id) {

    await pool.query(`

        UPDATE crawl_queue

        SET

            status = 'completed',

            finished_at = NOW()

        WHERE id = $1

    `, [
        id
    ]);
}


// ========================================
// 큐 항목 실패
// ========================================

async function markQueueFailed(
    id,
    error
) {

    await pool.query(`

        UPDATE crawl_queue

        SET

            status = 'failed',

            finished_at = NOW(),

            last_error = $2

        WHERE id = $1

    `, [

        id,

        String(
            error || "Unknown error"
        ).slice(
            0,
            1000
        )

    ]);
}


// ========================================
// 캐시
// ========================================

const robotsCache =
    new Map();

const sitemapCache =
    new Map();


// ========================================
// 유틸
// ========================================

function sleep(ms) {

    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}


function normalizeUrl(
    url,
    baseUrl
) {

    try {

        const parsed =
            new URL(
                url,
                baseUrl
            );


        // HTTP / HTTPS만 허용

        if (

            parsed.protocol !== "http:" &&

            parsed.protocol !== "https:"

        ) {

            return null;
        }


        // 사용자명 / 비밀번호가 들어간 URL 제외

        if (
            parsed.username ||
            parsed.password
        ) {

            return null;
        }


        // fragment 제거

        parsed.hash = "";


        // 기본 포트 제거

        if (

            (
                parsed.protocol === "http:" &&
                parsed.port === "80"
            ) ||

            (
                parsed.protocol === "https:" &&
                parsed.port === "443"
            )

        ) {

            parsed.port = "";
        }


        return parsed.href;

    } catch {

        return null;
    }
}


function getDomain(url) {

    try {

        return new URL(
            url
        ).hostname.toLowerCase();

    } catch {

        return "";
    }
}


function getOrigin(url) {

    try {

        return new URL(
            url
        ).origin;

    } catch {

        return "";
    }
}


// ========================================
// HTML 여부 확인
// ========================================

function isProbablyHtml(
    url,
    contentType = ""
) {

    const lower =
        url.toLowerCase();


    const blockedExtensions = [

        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webp",
        ".svg",
        ".ico",
        ".bmp",

        ".mp3",
        ".wav",
        ".ogg",

        ".mp4",
        ".webm",
        ".avi",
        ".mov",
        ".mkv",

        ".zip",
        ".rar",
        ".7z",
        ".tar",
        ".gz",

        ".pdf",

        ".exe",
        ".dmg",
        ".iso",
        ".apk",
        ".bin",

        ".css",
        ".js",
        ".json",
        ".xml"

    ];


    const pathname =
        lower.split("?")[0];


    if (

        blockedExtensions.some(
            ext =>
                pathname.endsWith(ext)
        )

    ) {

        return false;
    }


    if (

        contentType &&

        !contentType.includes(
            "text/html"
        ) &&

        !contentType.includes(
            "application/xhtml+xml"
        )

    ) {

        return false;
    }


    return true;
}


// ========================================
// robots.txt
// ========================================

async function getRobots(url) {

    let parsed;


    try {

        parsed =
            new URL(url);

    } catch {

        return null;
    }


    const origin =
        parsed.origin;


    if (
        robotsCache.has(origin)
    ) {

        return robotsCache.get(
            origin
        );
    }


    const robotsUrl =
        `${origin}/robots.txt`;


    try {

        const response =
            await fetch(

                robotsUrl,

                {

                    signal:
                        AbortSignal.timeout(
                            REQUEST_TIMEOUT
                        ),

                    headers: {

                        "User-Agent":
                            "OSCADIA-Bot/1.0"

                    }

                }

            );


        let text = "";


        if (
            response.ok
        ) {

            text =
                await response.text();
        }


        const robots =
            robotsParser(
                robotsUrl,
                text
            );


        robotsCache.set(
            origin,
            robots
        );


        return robots;

    } catch {

        // robots.txt를 가져오지 못한 경우
        // 빈 robots 정책 사용

        const robots =
            robotsParser(
                robotsUrl,
                ""
            );


        robotsCache.set(
            origin,
            robots
        );


        return robots;
    }
}


async function allowedByRobots(
    url
) {

    try {

        const robots =
            await getRobots(
                url
            );


        if (!robots) {

            return false;
        }


        return (

            robots.isAllowed(

                url,

                "OSCADIA-Bot"

            ) !== false

        );

    } catch {

        return false;
    }
}


// ========================================
// Sitemap
// ========================================

async function getSitemapUrls(
    origin
) {

    if (
        sitemapCache.has(origin)
    ) {

        return sitemapCache.get(
            origin
        );
    }


    const discovered =
        new Set();


    try {

        const robotsUrl =
            `${origin}/robots.txt`;


        const response =
            await fetch(

                robotsUrl,

                {

                    signal:
                        AbortSignal.timeout(
                            REQUEST_TIMEOUT
                        ),

                    headers: {

                        "User-Agent":
                            "OSCADIA-Bot/1.0"

                    }

                }

            );


        const sitemapLocations =
            [];


        if (
            response.ok
        ) {

            const text =
                await response.text();


            for (

                const line

                of text.split(
                    /\r?\n/
                )

            ) {

                const trimmed =
                    line.trim();


                if (

                    trimmed
                        .toLowerCase()
                        .startsWith(
                            "sitemap:"
                        )

                ) {

                    const sitemap =
                        trimmed
                            .slice(8)
                            .trim();


                    if (sitemap) {

                        sitemapLocations.push(
                            sitemap
                        );
                    }
                }
            }
        }


        // robots.txt에 Sitemap이 없으면
        // 기본 sitemap.xml 시도

        if (
            sitemapLocations.length === 0
        ) {

            sitemapLocations.push(
                `${origin}/sitemap.xml`
            );
        }


        for (

            const sitemapUrl

            of sitemapLocations

        ) {

            await collectSitemapUrls(

                sitemapUrl,

                discovered,

                new Set()

            );


            if (

                discovered.size >=
                MAX_SITEMAP_URLS_PER_DOMAIN

            ) {

                break;
            }
        }

    } catch {

        // sitemap 오류는 무시
    }


    const result =

        Array.from(
            discovered
        ).slice(
            0,
            MAX_SITEMAP_URLS_PER_DOMAIN
        );


    sitemapCache.set(
        origin,
        result
    );


    return result;
}


async function collectSitemapUrls(

    sitemapUrl,

    result,

    visitedSitemaps

) {

    if (

        result.size >=
        MAX_SITEMAP_URLS_PER_DOMAIN

    ) {

        return;
    }


    const normalized =
        normalizeUrl(
            sitemapUrl,
            sitemapUrl
        );


    if (!normalized) {

        return;
    }


    if (
        visitedSitemaps.has(
            normalized
        )
    ) {

        return;
    }


    visitedSitemaps.add(
        normalized
    );


    try {

        const response =
            await fetch(

                normalized,

                {

                    signal:
                        AbortSignal.timeout(
                            REQUEST_TIMEOUT
                        ),

                    headers: {

                        "User-Agent":
                            "OSCADIA-Bot/1.0"

                    }

                }

            );


        if (
            !response.ok
        ) {

            return;
        }


        const text =
            await response.text();


        if (
            !text.includes("<")
        ) {

            return;
        }


        const $ =
            cheerio.load(

                text,

                {
                    xmlMode: true
                }

            );


        // --------------------------------
        // Sitemap Index
        // --------------------------------

        const childSitemaps =
            [];


        $("sitemap > loc").each(

            (_, element) => {

                const loc =
                    $(element)
                        .text()
                        .trim();


                if (loc) {

                    childSitemaps.push(
                        loc
                    );
                }

            }

        );


        for (

            const loc

            of childSitemaps

        ) {

            if (

                result.size >=
                MAX_SITEMAP_URLS_PER_DOMAIN

            ) {

                break;
            }


            await collectSitemapUrls(

                loc,

                result,

                visitedSitemaps

            );
        }


        // --------------------------------
        // 일반 Sitemap
        // --------------------------------

        $("url > loc").each(

            (_, element) => {

                if (

                    result.size >=
                    MAX_SITEMAP_URLS_PER_DOMAIN

                ) {

                    return;
                }


                const loc =
                    $(element)
                        .text()
                        .trim();


                const url =
                    normalizeUrl(

                        loc,

                        normalized

                    );


                if (url) {

                    result.add(
                        url
                    );
                }

            }

        );

    } catch {

        // sitemap 오류 무시
    }
}


// ========================================
// 페이지 가져오기
// ========================================

async function fetchPage(
    url
) {

    try {

        const response =
            await fetch(

                url,

                {

                    signal:
                        AbortSignal.timeout(
                            REQUEST_TIMEOUT
                        ),

                    redirect:
                        "follow",

                    headers: {

                        "User-Agent":
                            "OSCADIA-Bot/1.0 (+https://oscadia-api.onrender.com)",

                        "Accept":
                            "text/html,application/xhtml+xml"

                    }

                }

            );


        if (
            !response.ok
        ) {

            console.log(

                `[SKIP] ${url} -> HTTP ${response.status}`

            );

            return null;
        }


        const contentType =
            response.headers.get(
                "content-type"
            ) || "";


        if (

            !isProbablyHtml(
                url,
                contentType
            )

        ) {

            return null;
        }


        const html =
            await response.text();


        return {

            html,

            contentType,

            finalUrl:
                response.url

        };

    } catch (error) {

        console.log(

            `[ERROR] ${url}: ${error.message}`

        );

        return null;
    }
}


// ========================================
// 자동 키워드 추출
// ========================================

function extractKeywords(

    title,

    description,

    content,

    metaKeywords,

    headings,

    domain

) {

    const text = `

        ${title}

        ${description}

        ${metaKeywords}

        ${headings}

        ${content.slice(0, 30000)}

        ${domain}

    `

        .toLowerCase()

        .replace(
            /[^\p{L}\p{N}\s.-]/gu,
            " "
        );


    const words =
        text

            .split(/\s+/)

            .filter(
                word =>
                    word.length >= 2
            );


    // --------------------------------
    // 자주 등장하지만 의미가 적은 단어
    // --------------------------------

    const stopWords =
        new Set([

            "the",
            "and",
            "for",
            "with",
            "this",
            "that",
            "from",
            "your",
            "have",
            "will",

            "www",
            "http",
            "https",

            "com",
            "org",
            "net",

            "html",
            "home",
            "page",
            "site",

            "menu",
            "more",
            "click",

            "login",
            "sign",
            "about"

        ]);


    const counts =
        new Map();


    for (
        const word
        of words
    ) {

        if (
            stopWords.has(word)
        ) {

            continue;
        }


        counts.set(

            word,

            (
                counts.get(word) ||
                0
            ) + 1

        );
    }


    // --------------------------------
    // 제목에 나온 단어는 가중치 증가
    // --------------------------------

    const titleWords =

        title

            .toLowerCase()

            .replace(
                /[^\p{L}\p{N}\s.-]/gu,
                " "
            )

            .split(/\s+/)

            .filter(
                word =>
                    word.length >= 2
            );


    for (
        const word
        of titleWords
    ) {

        if (
            stopWords.has(word)
        ) {

            continue;
        }


        counts.set(

            word,

            (
                counts.get(word) ||
                0
            ) + 10

        );
    }


    // --------------------------------
    // meta keywords도 추가
    // --------------------------------

    const metaWords =

        metaKeywords

            .toLowerCase()

            .split(/[,\s]+/)

            .filter(
                word =>
                    word.length >= 2
            );


    for (
        const word
        of metaWords
    ) {

        counts.set(

            word,

            (
                counts.get(word) ||
                0
            ) + 15

        );
    }


    return [

        ...counts.entries()

    ]

        .sort(

            (a, b) =>
                b[1] - a[1]

        )

        .slice(
            0,
            50
        )

        .map(
            item =>
                item[0]
        )

        .join(", ");
}


// ========================================
// HTML 분석
// ========================================

function parsePage(

    html,

    url

) {

    const $ =
        cheerio.load(
            html
        );


    // --------------------------------
    // 불필요한 요소 제거
    // --------------------------------

    $("script").remove();

    $("style").remove();

    $("noscript").remove();

    $("svg").remove();

    $("iframe").remove();


    // --------------------------------
    // 제목
    // --------------------------------

    const title =

        $("title")
            .first()
            .text()
            .trim() ||

        $("h1")
            .first()
            .text()
            .trim() ||

        getDomain(url);


    // --------------------------------
    // 설명
    // --------------------------------

    const description =

        $('meta[name="description"]')
            .attr("content")
            ?.trim() || "";


    // --------------------------------
    // Meta keywords
    // --------------------------------

    const metaKeywords =

        $('meta[name="keywords"]')
            .attr("content")
            ?.trim() || "";


    // --------------------------------
    // Open Graph 설명
    // --------------------------------

    const ogDescription =

        $('meta[property="og:description"]')
            .attr("content")
            ?.trim() || "";


    const ogTitle =

        $('meta[property="og:title"]')
            .attr("content")
            ?.trim() || "";


    // --------------------------------
    // 제목/헤딩 수집
    // --------------------------------

    const headings = [];


    $("h1, h2, h3, h4").each(

        (_, element) => {

            const text =
                $(element)
                    .text()
                    .trim();


            if (text) {

                headings.push(
                    text
                );
            }

        }

    );


    // --------------------------------
    // 본문
    // --------------------------------

    const content =

        $("body")
            .text()
            .replace(
                /\s+/g,
                " "
            )
            .trim()
            .slice(
                0,
                MAX_CONTENT
            );


    // --------------------------------
    // 링크
    // --------------------------------

    const links = [];


    $("a[href]").each(

        (_, element) => {

            const href =
                $(element)
                    .attr("href");


            if (!href) {

                return;
            }


            const normalized =
                normalizeUrl(

                    href,

                    url

                );


            if (normalized) {

                links.push(
                    normalized
                );
            }

        }

    );


    // --------------------------------
    // 키워드 자동 생성
    // --------------------------------

    const keywords =

        extractKeywords(

            `${title} ${ogTitle}`,

            `${description} ${ogDescription}`,

            content,

            metaKeywords,

            headings.join(" "),

            getDomain(url)

        );


    return {

        title:
            title || ogTitle,

        description:
            description || ogDescription,

        content,

        keywords,

        links

    };
}


// ========================================
// DB 저장
// ========================================

async function savePage(

    url,

    data

) {

    const domain =
        getDomain(url);


    const query = `

        INSERT INTO pages (

            url,

            title,

            description,

            domain,

            content,

            keywords,

            last_crawled

        )

        VALUES (

            $1,

            $2,

            $3,

            $4,

            $5,

            $6,

            NOW()

        )

        ON CONFLICT (url)

        DO UPDATE SET

            title =
                EXCLUDED.title,

            description =
                EXCLUDED.description,

            domain =
                EXCLUDED.domain,

            content =
                EXCLUDED.content,

            keywords =
                EXCLUDED.keywords,

            last_crawled =
                NOW()

    `;


    await pool.query(

        query,

        [

            url,

            data.title,

            data.description,

            domain,

            data.content,

            data.keywords

        ]

    );
}


// ========================================
// 사용자 큐 한 개 처리 실패 처리
// ========================================

async function failUserQueueItem(

    queueId,

    message

) {

    if (!queueId) {
        return;
    }


    try {

        await markQueueFailed(

            queueId,

            message

        );

    } catch (error) {

        console.error(

            "[QUEUE FAIL ERROR]",

            error.message

        );
    }
}


// ========================================
// 크롤러
// ========================================

async function crawl() {

    console.log(
        "================================"
    );

    console.log(
        "OSCADIA CRAWLER START"
    );

    console.log(
        "================================"
    );


    // --------------------------------
    // 매 실행마다 새 큐
    // --------------------------------

    const visited =
        new Set();


    const queue =
        [];


    // ========================================
    // 1. 사용자 요청 큐 먼저 추가
    // ========================================

    const userQueue =
        await getUserCrawlQueue();


    for (
        const item
        of userQueue
    ) {

        const normalized =
            normalizeUrl(

                item.url,

                item.url

            );


        if (!normalized) {

            await failUserQueueItem(

                item.id,

                "올바르지 않은 URL"

            );

            continue;
        }


        queue.push({

            url:
                normalized,

            depth:
                0,

            source:
                "user",

            queueId:
                item.id

        });
    }


    // ========================================
    // 2. 기본 SEED_URLS 추가
    // ========================================

    for (

        const url

        of SEED_URLS

    ) {

        const normalized =
            normalizeUrl(

                url,

                url

            );


        if (!normalized) {

            continue;
        }


        if (

            queue.some(

                item =>
                    item.url ===
                    normalized

            )

        ) {

            continue;
        }


        queue.push({

            url:
                normalized,

            depth:
                0,

            source:
                "seed",

            queueId:
                null

        });
    }


    let crawled = 0;


    const discoveredDomains =
        new Set();


    // =================================
    // 크롤링 시작
    // =================================

    while (

        queue.length > 0 &&

        crawled < MAX_PAGES

    ) {

        const item =
            queue.shift();


        if (!item) {

            break;
        }


        const {

            url,

            depth,

            source,

            queueId

        } = item;


        // --------------------------------
        // 사용자 큐 시작 상태
        // --------------------------------

        if (

            source === "user" &&

            queueId

        ) {

            try {

                await markQueueStarted(
                    queueId
                );

            } catch (error) {

                console.error(

                    "[QUEUE START ERROR]",

                    error.message

                );
            }
        }


        // --------------------------------
        // 중복 URL
        // --------------------------------

        if (
            visited.has(url)
        ) {

            await failUserQueueItem(

                queueId,

                "이미 처리된 URL"

            );

            continue;
        }


        // --------------------------------
        // 깊이 제한
        // --------------------------------

        if (
            depth > MAX_DEPTH
        ) {

            await failUserQueueItem(

                queueId,

                "최대 크롤링 깊이 초과"

            );

            continue;
        }


        visited.add(
            url
        );


        console.log(

            `[${crawled + 1}/${MAX_PAGES}] ${url}`

        );


        // --------------------------------
        // robots.txt
        // --------------------------------

        const allowed =
            await allowedByRobots(
                url
            );


        if (!allowed) {

            console.log(

                `[ROBOTS] 접근 허용 안 됨: ${url}`

            );


            await failUserQueueItem(

                queueId,

                "robots.txt에서 크롤링이 허용되지 않음"

            );


            continue;
        }


        // --------------------------------
        // 새로운 도메인
        // --------------------------------

        const origin =
            getOrigin(
                url
            );


        if (

            origin &&

            !discoveredDomains.has(
                origin
            )

        ) {

            discoveredDomains.add(
                origin
            );


            console.log(

                `[DISCOVERED DOMAIN] ${origin}`

            );


            // --------------------------------
            // sitemap 자동 발견
            // --------------------------------

            const sitemapUrls =
                await getSitemapUrls(
                    origin
                );


            if (
                sitemapUrls.length > 0
            ) {

                console.log(

                    `[SITEMAP] ${origin} -> ${sitemapUrls.length} URLs`

                );


                for (

                    const sitemapUrl

                    of sitemapUrls

                ) {

                    if (

                        visited.has(
                            sitemapUrl
                        )

                    ) {

                        continue;
                    }


                    if (

                        queue.some(

                            item =>
                                item.url ===
                                sitemapUrl

                        )

                    ) {

                        continue;
                    }


                    if (

                        queue.length >=
                        MAX_QUEUE_SIZE

                    ) {

                        break;
                    }


                    queue.push({

                        url:
                            sitemapUrl,

                        depth:

                            Math.min(

                                depth + 1,

                                MAX_DEPTH

                            ),

                        source:
                            "sitemap",

                        queueId:
                            null

                    });
                }
            }
        }


        // --------------------------------
        // 요청 간격
        // --------------------------------

        await sleep(
            REQUEST_DELAY
        );


        // --------------------------------
        // 페이지 가져오기
        // --------------------------------

        const page =
            await fetchPage(
                url
            );


        if (!page) {

            await failUserQueueItem(

                queueId,

                "페이지를 가져오지 못했습니다."

            );


            continue;
        }


        const finalUrl =

            page.finalUrl ||

            url;


        visited.add(
            finalUrl
        );


        // --------------------------------
        // HTML 분석
        // --------------------------------

        const data =
            parsePage(

                page.html,

                finalUrl

            );


        // --------------------------------
        // 내용이 너무 없는 페이지 제외
        // --------------------------------

        if (

            data.content.length < 50 &&

            data.title.length < 2

        ) {

            console.log(

                "[SKIP] 내용이 너무 적음"

            );


            await failUserQueueItem(

                queueId,

                "페이지 내용이 너무 적습니다."

            );


            continue;
        }


        // --------------------------------
        // DB 저장
        // --------------------------------

        try {

            await savePage(

                finalUrl,

                data

            );


            console.log(

                `[SAVED] ${data.title}`

            );


            crawled++;


            // --------------------------------
            // 사용자 요청 URL 완료
            // --------------------------------

            if (

                source === "user" &&

                queueId

            ) {

                try {

                    await markQueueFinished(

                        queueId

                    );

                } catch (queueError) {

                    console.error(

                        "[QUEUE FINISH ERROR]",

                        queueError.message

                    );
                }
            }


        } catch (error) {

            console.error(
                "[DB ERROR]"
            );


            console.error(
                "message:",
                error.message
            );


            console.error(
                "code:",
                error.code
            );


            console.error(
                "detail:",
                error.detail
            );


            console.error(
                "hint:",
                error.hint
            );


            await failUserQueueItem(

                queueId,

                error.message

            );
        }


        // =================================
        // 링크 발견
        // =================================

        if (

            depth < MAX_DEPTH

        ) {

            for (

                const link

                of data.links

            ) {

                if (

                    visited.has(link)

                ) {

                    continue;
                }


                if (

                    queue.some(

                        item =>
                            item.url ===
                            link

                    )

                ) {

                    continue;
                }


                if (

                    queue.length >=
                    MAX_QUEUE_SIZE

                ) {

                    break;
                }


                const linkDomain =
                    getDomain(
                        link
                    );


                const currentDomain =
                    getDomain(
                        finalUrl
                    );


                // --------------------------------
                // 외부 도메인 발견
                // --------------------------------

                if (

                    linkDomain &&

                    linkDomain !==
                    currentDomain

                ) {

                    console.log(

                        `[NEW DOMAIN] ${linkDomain}`

                    );
                }


                queue.push({

                    url:
                        link,

                    depth:
                        depth + 1,

                    source:
                        "link",

                    queueId:
                        null

                });
            }
        }
    }


    // =================================
    // 종료
    // =================================

    console.log(
        "================================"
    );


    console.log(

        `OSCADIA CRAWLER FINISHED: ${crawled} pages`

    );


    console.log(

        `DISCOVERED DOMAINS: ${discoveredDomains.size}`

    );


    console.log(

        `REMAINING QUEUE: ${queue.length}`

    );


    console.log(
        "================================"
    );
}


// ========================================
// export
// ========================================

export {

    crawl

};


// ========================================
// 직접 실행했을 때
// ========================================

if (

    process.argv[1] ===

    new URL(
        import.meta.url
    ).pathname

) {

    crawl().catch(

        error => {

            console.error(

                "CRAWLER FAILED:",

                error

            );


            process.exit(1);
        }

    );
}