import nodemailer from "nodemailer";
import { createClient } from "@supabase/supabase-js";


/* =========================================
   기본 Supabase 설정
========================================= */

const SUPABASE_URL =
    process.env.SUPABASE_URL;

const SUPABASE_ANON_KEY =
    process.env.SUPABASE_ANON_KEY;


/* =========================================
   SMTP
========================================= */

const transporter =
    nodemailer.createTransport({

        host: process.env.SMTP_HOST,

        port:
            Number(
                process.env.SMTP_PORT || 587
            ),

        secure:
            String(
                process.env.SMTP_SECURE
            ).toLowerCase() === "true",

        auth: {

            user:
                process.env.SMTP_USER,

            pass:
                process.env.SMTP_PASS

        }

    });


/* =========================================
   SMTP 테스트
========================================= */

export async function verifySMTP(){

    try{

        await transporter.verify();

        console.log(
            "OSmail SMTP connection: OK"
        );

        return true;

    }catch(error){

        console.error(
            "OSmail SMTP connection failed:",
            error.message
        );

        return false;

    }

}


/* =========================================
   요청 사용자 인증
========================================= */

async function getAuthContext(req){

    const auth =
        req.headers.authorization || "";

    if(!auth.startsWith("Bearer ")){

        throw new Error(
            "로그인이 필요합니다."
        );

    }

    const token =
        auth.substring(7);

    if(!token){

        throw new Error(
            "로그인 정보가 없습니다."
        );

    }


    /*
     * 사용자 토큰으로 Supabase client 생성.
     *
     * 이 부분이 중요하다.
     * 단순히 서버의 anon key로만 DB를 호출하면
     * RLS에서 사용자를 제대로 인식하지 못할 수 있다.
     */

    const userSupabase =
        createClient(
            SUPABASE_URL,
            SUPABASE_ANON_KEY,
            {
                global:{
                    headers:{
                        Authorization:
                            `Bearer ${token}`
                    }
                }
            }
        );


    const {
        data,
        error
    } =
        await userSupabase.auth.getUser(
            token
        );


    if(
        error ||
        !data?.user
    ){

        throw new Error(
            "로그인 정보가 유효하지 않습니다."
        );

    }


    return {

        user:
            data.user,

        supabase:
            userSupabase

    };

}


/* =========================================
   프로필 조회
========================================= */

async function getProfile(
    supabase,
    userId
){

    const {
        data,
        error
    } =
        await supabase
            .from("osmail_profiles")
            .select("*")
            .eq("id", userId)
            .maybeSingle();


    if(error){

        throw new Error(
            error.message
        );

    }


    return data;

}


/* =========================================
   주소 처리
========================================= */

function normalizeOSmailAddress(
    address
){

    return String(address || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "");

}


function isInternalAddress(
    address
){

    return normalizeOSmailAddress(
        address
    ).endsWith("@osmail");

}


function getOSmailId(
    address
){

    return normalizeOSmailAddress(
        address
    ).replace(
        /@osmail$/,
        ""
    );

}


function makeOSmailAddress(
    osmailId
){

    return `${osmailId}@osmail`;

}


/* =========================================
   현재 사용자 정보
========================================= */

export async function getMyOSmail(req){

    const {
        user,
        supabase
    } =
        await getAuthContext(req);


    const profile =
        await getProfile(
            supabase,
            user.id
        );


    return {

        user,

        profile,

        address:
            profile
                ? makeOSmailAddress(
                    profile.osmail_id
                )
                : null

    };

}


/* =========================================
   OSmail ID 생성
========================================= */

export async function createOSmailProfile(
    req,
    osmailId,
    displayName
){

    const {
        user,
        supabase
    } =
        await getAuthContext(req);


    osmailId =
        String(
            osmailId || ""
        )
        .trim()
        .toLowerCase();


    displayName =
        String(
            displayName || ""
        )
        .trim();


    if(
        !/^[A-Za-z0-9_]{3,20}$/.test(
            osmailId
        )
    ){

        throw new Error(
            "OSmail ID는 영문, 숫자, 밑줄(_)만 사용하여 3~20자로 입력하세요."
        );

    }


    /*
     * ID 중복 확인
     */

    const {
        data: existing,
        error: existingError
    } =
        await supabase
            .from("osmail_profiles")
            .select("id")
            .eq(
                "osmail_id",
                osmailId
            )
            .maybeSingle();


    if(existingError){

        throw new Error(
            existingError.message
        );

    }


    if(
        existing &&
        existing.id !== user.id
    ){

        throw new Error(
            "이미 사용 중인 OSmail ID입니다."
        );

    }


    /*
     * 프로필 생성
     */

    const {
        data,
        error
    } =
        await supabase
            .from("osmail_profiles")
            .upsert({

                id:
                    user.id,

                osmail_id:
                    osmailId,

                display_name:
                    displayName ||
                    null

            })
            .select()
            .single();


    if(error){

        throw new Error(
            error.message
        );

    }


    return {

        profile:
            data,

        address:
            makeOSmailAddress(
                osmailId
            )

    };

}


/* =========================================
   내부 OSmail 전송
========================================= */

export async function sendInternalMail(
    req,
    {
        to,
        subject,
        body
    }
){

    const {
        user,
        supabase
    } =
        await getAuthContext(req);


    const senderProfile =
        await getProfile(
            supabase,
            user.id
        );


    if(!senderProfile){

        throw new Error(
            "먼저 OSmail 주소를 만들어야 합니다."
        );

    }


    const recipientAddress =
        normalizeOSmailAddress(
            to
        );


    if(
        !isInternalAddress(
            recipientAddress
        )
    ){

        throw new Error(
            "내부 OSmail 주소가 아닙니다."
        );

    }


    const recipientOSmailId =
        getOSmailId(
            recipientAddress
        );


    const {
        data: recipientProfile,
        error: recipientError
    } =
        await supabase
            .from("osmail_profiles")
            .select("*")
            .eq(
                "osmail_id",
                recipientOSmailId
            )
            .maybeSingle();


    if(recipientError){

        throw new Error(
            recipientError.message
        );

    }


    if(!recipientProfile){

        throw new Error(
            "존재하지 않는 OSmail 주소입니다."
        );

    }


    const senderAddress =
        makeOSmailAddress(
            senderProfile.osmail_id
        );


    const finalSubject =
        String(
            subject || ""
        ).trim();


    const finalBody =
        String(
            body || ""
        );


    if(!finalSubject){

        throw new Error(
            "제목을 입력하세요."
        );

    }


    if(!finalBody.trim()){

        throw new Error(
            "내용을 입력하세요."
        );

    }


    const {
        data,
        error
    } =
        await supabase
            .from("osmail_emails")
            .insert({

                sender_id:
                    user.id,

                recipient_id:
                    recipientProfile.id,

                sender_address:
                    senderAddress,

                recipient_address:
                    recipientAddress,

                subject:
                    finalSubject,

                body:
                    finalBody,

                is_read:
                    false,

                sender_deleted:
                    false,

                recipient_deleted:
                    false,

                is_external:
                    false,

                external_message_id:
                    null

            })
            .select()
            .single();


    if(error){

        throw new Error(
            error.message
        );

    }


    return data;

}


/* =========================================
   외부 이메일 전송
========================================= */

export async function sendExternalMail(
    req,
    {
        to,
        subject,
        body
    }
){

    const {
        user,
        supabase
    } =
        await getAuthContext(req);


    const senderProfile =
        await getProfile(
            supabase,
            user.id
        );


    if(!senderProfile){

        throw new Error(
            "먼저 OSmail 주소를 만들어야 합니다."
        );

    }


    const recipientAddress =
        String(
            to || ""
        ).trim();


    if(!recipientAddress){

        throw new Error(
            "받는 사람 이메일을 입력하세요."
        );

    }


    const emailPattern =
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/;


    if(
        !emailPattern.test(
            recipientAddress
        )
    ){

        throw new Error(
            "올바른 이메일 주소를 입력하세요."
        );

    }


    if(
        isInternalAddress(
            recipientAddress
        )
    ){

        throw new Error(
            "내부 OSmail 주소입니다. 내부 메일 전송을 사용하세요."
        );

    }


    const senderAddress =
        makeOSmailAddress(
            senderProfile.osmail_id
        );


    const finalSubject =
        String(
            subject || ""
        ).trim();


    const finalBody =
        String(
            body || ""
        );


    if(!finalSubject){

        throw new Error(
            "제목을 입력하세요."
        );

    }


    if(!finalBody.trim()){

        throw new Error(
            "내용을 입력하세요."
        );

    }


    const fromAddress =
        process.env.SMTP_FROM ||
        process.env.SMTP_USER;


    if(!fromAddress){

        throw new Error(
            "SMTP_FROM 또는 SMTP_USER가 설정되지 않았습니다."
        );

    }


    let info;


    try{

        info =
            await transporter.sendMail({

                from:
                    fromAddress,

                to:
                    recipientAddress,

                subject:
                    finalSubject,

                text:
                    finalBody,

                replyTo:
                    fromAddress,

                headers:{
                    "X-OSmail":
                        "OSmail"
                }

            });

    }catch(error){

        console.error(
            "External mail send error:",
            error
        );


        throw new Error(
            "외부 이메일 전송에 실패했습니다: " +
            error.message
        );

    }


    /*
     * 외부 전송 성공 후
     * 보낸 편지함에도 저장
     */

    const {
        data,
        error
    } =
        await supabase
            .from("osmail_emails")
            .insert({

                sender_id:
                    user.id,

                recipient_id:
                    null,

                sender_address:
                    senderAddress,

                recipient_address:
                    recipientAddress,

                subject:
                    finalSubject,

                body:
                    finalBody,

                is_read:
                    true,

                sender_deleted:
                    false,

                recipient_deleted:
                    false,

                is_external:
                    true,

                external_message_id:
                    info.messageId ||
                    null

            })
            .select()
            .single();


    if(error){

        console.error(
            "External mail sent but DB save failed:",
            error
        );


        throw new Error(
            "메일은 외부로 전송되었지만 보낸 편지함 저장에 실패했습니다."
        );

    }


    return {

        email:
            data,

        messageId:
            info.messageId

    };

}


/* =========================================
   메일 목록
========================================= */

export async function getEmails(req){

    const {
        user,
        supabase
    } =
        await getAuthContext(req);


    const {
        data,
        error
    } =
        await supabase
            .from("osmail_emails")
            .select("*")
            .or(
                `sender_id.eq.${user.id},recipient_id.eq.${user.id}`
            )
            .order(
                "created_at",
                {
                    ascending:false
                }
            );


    if(error){

        throw new Error(
            error.message
        );

    }


    return data || [];

}


/* =========================================
   읽음 처리
========================================= */

export async function markAsRead(
    req,
    emailId
){

    const {
        user,
        supabase
    } =
        await getAuthContext(req);


    const {
        data: email,
        error: findError
    } =
        await supabase
            .from("osmail_emails")
            .select("*")
            .eq(
                "id",
                emailId
            )
            .single();


    if(
        findError ||
        !email
    ){

        throw new Error(
            "메일을 찾을 수 없습니다."
        );

    }


    if(
        email.recipient_id !==
        user.id
    ){

        throw new Error(
            "읽음 처리를 할 권한이 없습니다."
        );

    }


    const {
        data,
        error
    } =
        await supabase
            .from("osmail_emails")
            .update({
                is_read:true
            })
            .eq(
                "id",
                emailId
            )
            .select()
            .single();


    if(error){

        throw new Error(
            error.message
        );

    }


    return data;

}


/* =========================================
   삭제
========================================= */

export async function deleteEmail(
    req,
    emailId
){

    const {
        user,
        supabase
    } =
        await getAuthContext(req);


    const {
        data: email,
        error: findError
    } =
        await supabase
            .from("osmail_emails")
            .select("*")
            .eq(
                "id",
                emailId
            )
            .single();


    if(
        findError ||
        !email
    ){

        throw new Error(
            "메일을 찾을 수 없습니다."
        );

    }


    const update = {};


    if(
        email.sender_id ===
        user.id
    ){

        update.sender_deleted =
            true;

    }


    if(
        email.recipient_id ===
        user.id
    ){

        update.recipient_deleted =
            true;

    }


    if(
        Object.keys(update).length === 0
    ){

        throw new Error(
            "삭제 권한이 없습니다."
        );

    }


    const {
        data,
        error
    } =
        await supabase
            .from("osmail_emails")
            .update(update)
            .eq(
                "id",
                emailId
            )
            .select()
            .single();


    if(error){

        throw new Error(
            error.message
        );

    }


    return data;

}


/* =========================================
   복구
========================================= */

export async function restoreEmail(
    req,
    emailId
){

    const {
        user,
        supabase
    } =
        await getAuthContext(req);


    const {
        data: email,
        error: findError
    } =
        await supabase
            .from("osmail_emails")
            .select("*")
            .eq(
                "id",
                emailId
            )
            .single();


    if(
        findError ||
        !email
    ){

        throw new Error(
            "메일을 찾을 수 없습니다."
        );

    }


    const update = {};


    if(
        email.sender_id ===
        user.id
    ){

        update.sender_deleted =
            false;

    }


    if(
        email.recipient_id ===
        user.id
    ){

        update.recipient_deleted =
            false;

    }


    if(
        Object.keys(update).length === 0
    ){

        throw new Error(
            "복구 권한이 없습니다."
        );

    }


    const {
        data,
        error
    } =
        await supabase
            .from("osmail_emails")
            .update(update)
            .eq(
                "id",
                emailId
            )
            .select()
            .single();


    if(error){

        throw new Error(
            error.message
        );

    }


    return data;

}


/* =========================================
   주소
========================================= */

export function getAddressFromProfile(
    profile
){

    if(!profile)
        return null;


    return makeOSmailAddress(
        profile.osmail_id
    );

}