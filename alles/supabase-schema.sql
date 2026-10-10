-- Alles schema, namespaced to avoid collisions with OSCADIA tables.
-- Run in Supabase SQL Editor on the same project only after reviewing this file.
create extension if not exists pgcrypto;

create table if not exists public.alles_articles (
 id uuid primary key default gen_random_uuid(), slug text not null unique, title text not null check(char_length(title) between 1 and 120),
 category text not null default '기타', categories text[] not null default array['기타']::text[], summary text not null default '', content text not null default '', sources text not null default '',
 image_url text, image_urls jsonb not null default '[]'::jsonb, links jsonb not null default '[]'::jsonb, video_url text,
 is_protected boolean not null default false, status text not null default 'published' check(status in ('draft','published','archived')),
 author_id uuid references auth.users(id) on delete set null, author_label text not null default '회원', deleted_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.alles_article_history (
 id bigint generated always as identity primary key, article_id uuid not null references public.alles_articles(id) on delete cascade,
 old_title text, old_slug text, old_category text, old_categories text[], old_summary text, old_content text, old_sources text, old_image_url text, old_image_urls jsonb, old_links jsonb, old_video_url text,
 changed_by uuid references auth.users(id) on delete set null, changed_by_label text, change_summary text not null default '문서 수정', changed_at timestamptz not null default now()
);
create table if not exists public.alles_revisions (
 id uuid primary key default gen_random_uuid(), article_id uuid not null references public.alles_articles(id) on delete cascade,
 proposed_data jsonb not null, submitted_by uuid references auth.users(id) on delete set null, status text not null default 'pending' check(status in ('pending','approved','rejected')),
 edit_summary text not null default '회원 수정 제안', reviewed_by uuid references auth.users(id) on delete set null, reviewed_at timestamptz, review_note text, created_at timestamptz not null default now()
);
create table if not exists public.alles_discussions (
 id uuid primary key default gen_random_uuid(), article_id uuid not null references public.alles_articles(id) on delete cascade,
 body text not null check(char_length(body) between 1 and 4000), author_id uuid references auth.users(id) on delete set null, author_label text not null default '회원',
 deleted_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.alles_reports (
 id uuid primary key default gen_random_uuid(), article_id uuid references public.alles_articles(id) on delete set null,
 reporter_id uuid references auth.users(id) on delete set null, reason text not null, details text not null default '', status text not null default 'open' check(status in ('open','resolved','dismissed')),
 reviewed_by uuid references auth.users(id) on delete set null, reviewed_at timestamptz, created_at timestamptz not null default now()
);
create table if not exists public.alles_user_roles (
 user_id uuid primary key references auth.users(id) on delete cascade, role text not null default 'member' check(role in ('member','admin')), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists alles_articles_published_idx on public.alles_articles(status,updated_at desc) where deleted_at is null;
create index if not exists alles_articles_categories_idx on public.alles_articles using gin(categories);
create index if not exists alles_history_article_idx on public.alles_article_history(article_id,changed_at desc);
create index if not exists alles_revisions_status_idx on public.alles_revisions(status,created_at desc);
create index if not exists alles_discussions_article_idx on public.alles_discussions(article_id,created_at asc);
create index if not exists alles_reports_status_idx on public.alles_reports(status,created_at desc);

create or replace function public.alles_is_admin() returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from public.alles_user_roles where user_id=auth.uid() and role='admin'); $$;
create or replace function public.alles_touch_updated_at() returns trigger language plpgsql set search_path=public as $$ begin new.updated_at=now(); return new; end; $$;
drop trigger if exists alles_articles_touch on public.alles_articles;
create trigger alles_articles_touch before update on public.alles_articles for each row execute function public.alles_touch_updated_at();
create or replace function public.alles_record_history() returns trigger language plpgsql security definer set search_path=public as $$
begin
 insert into public.alles_article_history(article_id,old_title,old_slug,old_category,old_categories,old_summary,old_content,old_sources,old_image_url,old_image_urls,old_links,old_video_url,changed_by,changed_by_label,change_summary)
 values(old.id,old.title,old.slug,old.category,old.categories,old.summary,old.content,old.sources,old.image_url,old.image_urls,old.links,old.video_url,auth.uid(),coalesce((select email from auth.users where id=auth.uid()),'회원'),'문서 수정');
 return new;
end; $$;
drop trigger if exists alles_articles_history_update on public.alles_articles;
create trigger alles_articles_history_update before update on public.alles_articles for each row execute function public.alles_record_history();

alter table public.alles_articles enable row level security; alter table public.alles_article_history enable row level security; alter table public.alles_revisions enable row level security; alter table public.alles_discussions enable row level security; alter table public.alles_reports enable row level security; alter table public.alles_user_roles enable row level security;
-- Policies are dropped/recreated for safe reruns.
drop policy if exists alles_articles_public_read on public.alles_articles; create policy alles_articles_public_read on public.alles_articles for select to anon,authenticated using(status='published' and deleted_at is null);
drop policy if exists alles_articles_member_insert on public.alles_articles; create policy alles_articles_member_insert on public.alles_articles for insert to authenticated with check(auth.uid()=author_id and deleted_at is null and status='published' and is_protected=false);
drop policy if exists alles_articles_member_update on public.alles_articles; create policy alles_articles_member_update on public.alles_articles for update to authenticated using(is_protected=false and deleted_at is null and status='published') with check(is_protected=false and deleted_at is null and status='published');
drop policy if exists alles_articles_admin_all on public.alles_articles; create policy alles_articles_admin_all on public.alles_articles for all to authenticated using(public.alles_is_admin()) with check(public.alles_is_admin());
drop policy if exists alles_history_read on public.alles_article_history; create policy alles_history_read on public.alles_article_history for select to anon,authenticated using(true);
drop policy if exists alles_revisions_insert on public.alles_revisions; create policy alles_revisions_insert on public.alles_revisions for insert to authenticated with check(auth.uid()=submitted_by and status='pending');
drop policy if exists alles_revisions_read on public.alles_revisions; create policy alles_revisions_read on public.alles_revisions for select to authenticated using(submitted_by=auth.uid() or public.alles_is_admin());
drop policy if exists alles_revisions_admin_update on public.alles_revisions; create policy alles_revisions_admin_update on public.alles_revisions for update to authenticated using(public.alles_is_admin()) with check(public.alles_is_admin());
drop policy if exists alles_discussions_read on public.alles_discussions; create policy alles_discussions_read on public.alles_discussions for select to anon,authenticated using(deleted_at is null);
drop policy if exists alles_discussions_insert on public.alles_discussions; create policy alles_discussions_insert on public.alles_discussions for insert to authenticated with check(auth.uid()=author_id);
drop policy if exists alles_discussions_admin_update on public.alles_discussions; create policy alles_discussions_admin_update on public.alles_discussions for update to authenticated using(public.alles_is_admin()) with check(public.alles_is_admin());
drop policy if exists alles_reports_insert on public.alles_reports; create policy alles_reports_insert on public.alles_reports for insert to authenticated with check(auth.uid()=reporter_id and status='open');
drop policy if exists alles_reports_admin_read on public.alles_reports; create policy alles_reports_admin_read on public.alles_reports for select to authenticated using(public.alles_is_admin());
drop policy if exists alles_reports_admin_update on public.alles_reports; create policy alles_reports_admin_update on public.alles_reports for update to authenticated using(public.alles_is_admin()) with check(public.alles_is_admin());
drop policy if exists alles_roles_read on public.alles_user_roles; create policy alles_roles_read on public.alles_user_roles for select to authenticated using(user_id=auth.uid() or public.alles_is_admin());
drop policy if exists alles_roles_admin_manage on public.alles_user_roles; create policy alles_roles_admin_manage on public.alles_user_roles for all to authenticated using(public.alles_is_admin()) with check(public.alles_is_admin());

grant select on public.alles_articles,public.alles_article_history,public.alles_discussions to anon,authenticated;
grant insert,update,delete on public.alles_articles to authenticated;
grant insert,select,update on public.alles_revisions to authenticated;
grant insert,select,update on public.alles_discussions to authenticated;
grant insert,select,update on public.alles_reports to authenticated;
grant select,insert,update,delete on public.alles_user_roles to authenticated;

-- Protected edit requests are applied only after a server-side admin check.
create or replace function public.alles_review_revision(p_revision_id uuid,p_approve boolean,p_note text default null) returns void language plpgsql security definer set search_path=public as $$
declare r public.alles_revisions%rowtype; d jsonb;
begin
 if not public.alles_is_admin() then raise exception '관리자 권한이 필요합니다.'; end if;
 select * into r from public.alles_revisions where id=p_revision_id for update;
 if not found then raise exception '수정 제안을 찾을 수 없습니다.'; end if;
 if r.status<>'pending' then raise exception '이미 처리된 제안입니다.'; end if;
 if p_approve then
  d=r.proposed_data;
  update public.alles_articles set title=d->>'title',slug=coalesce(nullif(d->>'slug',''),regexp_replace(d->>'title','\s+','-','g')),category=coalesce(d->>'category',(d->'categories'->>0),'기타'),categories=coalesce(array(select jsonb_array_elements_text(d->'categories')),array[coalesce(d->>'category','기타')]),summary=coalesce(d->>'summary',''),content=coalesce(d->>'content',''),sources=coalesce(d->>'sources',''),image_url=d->>'image_url',image_urls=coalesce(d->'image_urls','[]'::jsonb),links=coalesce(d->'links','[]'::jsonb),video_url=d->>'video_url' where id=r.article_id;
  update public.alles_revisions set status='approved',reviewed_by=auth.uid(),reviewed_at=now(),review_note=p_note where id=p_revision_id;
 else update public.alles_revisions set status='rejected',reviewed_by=auth.uid(),reviewed_at=now(),review_note=p_note where id=p_revision_id; end if;
end; $$;
grant execute on function public.alles_review_revision(uuid,boolean,text) to authenticated;

-- Public media bucket. Restrict uploads to authenticated users' own folder.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('alles-media','alles-media',true,26214400,array['image/jpeg','image/png','image/webp','image/gif','image/avif','video/mp4','video/webm','video/quicktime']) on conflict(id) do nothing;
drop policy if exists alles_media_public_read on storage.objects; create policy alles_media_public_read on storage.objects for select to anon,authenticated using(bucket_id='alles-media');
drop policy if exists alles_media_user_upload on storage.objects; create policy alles_media_user_upload on storage.objects for insert to authenticated with check(bucket_id='alles-media' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists alles_media_user_update on storage.objects; create policy alles_media_user_update on storage.objects for update to authenticated using(bucket_id='alles-media' and (storage.foldername(name))[1]=auth.uid()::text) with check(bucket_id='alles-media' and (storage.foldername(name))[1]=auth.uid()::text);
drop policy if exists alles_media_user_delete on storage.objects; create policy alles_media_user_delete on storage.objects for delete to authenticated using(bucket_id='alles-media' and (storage.foldername(name))[1]=auth.uid()::text);

-- Optional demo data; safe to run repeatedly.
insert into public.alles_articles(slug,title,category,categories,summary,content,sources,author_label,status) values
('세종대왕','세종대왕','역사',array['역사','인물','언어'],'조선 제4대 국왕으로, 훈민정음 창제와 여러 제도적 발전을 이끈 인물이다.','세종대왕(1397–1450)은 조선의 제4대 국왕이다. 1418년 즉위했으며, 재위 기간 동안 학문과 과학 기술, 음악, 농업 등 여러 분야의 발전을 장려했다.\n\n가장 널리 알려진 업적은 훈민정음 창제이다. 훈민정음은 1443년에 창제되었고 1446년에 반포되었다.','국사편찬위원회 한국사데이터베이스 | https://db.history.go.kr/','Alles 편집부','published'),
('태양계','태양계','과학',array['과학','지리'],'태양과 태양의 중력에 묶여 공전하는 천체들로 이루어진 행성계이다.','태양계는 중심별인 태양과 그 주위를 공전하는 행성, 위성, 왜소행성, 소행성, 혜성 및 여러 작은 천체로 이루어져 있다.','NASA Solar System Exploration | https://science.nasa.gov/solar-system/','Alles 편집부','published') on conflict(slug) do nothing;

-- ADMIN SETUP: sign up first, then run this after replacing the email with your own.
-- insert into public.alles_user_roles(user_id,role) select id,'admin' from auth.users where email='YOUR_EMAIL_HERE' on conflict(user_id) do update set role='admin';
-- Never put the Supabase service_role key in app.js.
