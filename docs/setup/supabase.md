# Supabase — setup

What you end up with: a `DATABASE_URL`, a storage bucket, and the schema
applied.

**Time:** ~10 minutes. **Cost:** free to start, $25/mo before real listings.

---

## 1. Create the project — get the region right

<https://supabase.com/dashboard> → **New project**

| Field | Value |
|---|---|
| Name | `portage-prod` (make a separate `portage-staging` later) |
| Database password | Generate a strong one and save it |
| **Region** | **Canada (Central) — `ca-central-1`** |

> **The region cannot be changed later.** Moving means creating a new project
> and migrating everything. Portage stores identity-verification records and
> a document locker holding leases and invoices — that is the crown-jewel
> PIPEDA risk, and it belongs in Canada. Get this right now; it is free.

## 2. Get the connection string

**Project Settings → Database → Connection string → URI**

Two forms matter:

| Use | Port | When |
|---|---|---|
| **Session pooler** | 5432 | Migrations, local development |
| **Transaction pooler** | 6543 | **Serverless (Vercel) — use this** |

Serverless opens a connection per invocation and will exhaust a direct
connection limit. Point production at the **transaction pooler**.

```bash
DATABASE_URL="postgresql://postgres.abcdefgh:PASSWORD@aws-0-ca-central-1.pooler.supabase.com:6543/postgres?sslmode=require"
```

`sslmode=require` is mandatory in production — `loadEnv()` refuses to start
without it.

## 3. Apply the schema

```bash
cd backend
npm install
npm run migrate
```

The runner applies each file once, in a transaction, records a checksum, and
takes an advisory lock so two deploys cannot race. Editing an applied
migration is refused — write a new one instead.

Verify:

```sql
select count(*) from information_schema.tables where table_schema = 'public';
-- expect 30+
```

## 4. Create the storage buckets

**Storage → New bucket**, both **Private**:

| Bucket | Holds |
|---|---|
| `listing-media` | Listing photos |
| `documents` | The document locker — leases, invoices, receipts |

Neither may be public. Access goes through short-lived signed URLs bound to
both the object and the requesting user.

## 5. Free tier: what actually breaks first

Free gives 500 MB database, 1 GB file storage, 5 GB egress, **no backups**,
and projects pause after 7 days of inactivity.

The database is not the constraint — **photos are**:

| Resource | Free limit | Reality |
|---|---|---|
| Database rows | 500 MB | Fine. 2,000 listings ≈ 10 MB |
| **File storage** | **1 GB** | ~10 photos × 300 KB ≈ 3 MB/listing → **~330 listings** |
| **Egress** | **5 GB/mo** | ~50 thumbnails/session ≈ 1.5 MB → ~3,300 sessions |
| **Backups** | **None** | Disqualifying once a real landlord stores a lease |

**Move to Pro ($25/mo) before your first real listing with photos** — for the
daily backups and point-in-time recovery more than the storage.

**Cut egress** by serving listing images through Vercel's CDN and image
optimization rather than hitting Supabase storage directly. You already pay
for Vercel Pro; this keeps you inside limits far longer.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `sslmode=require` startup error | Add it to the connection string. |
| `too many connections` | Using the direct connection from serverless. Switch to the transaction pooler on port 6543. |
| `Migration X was modified after being applied` | An applied migration file changed. Revert it and write a new migration. |
| Project unreachable after a quiet week | Free tier paused it. Unpause in the dashboard. |
