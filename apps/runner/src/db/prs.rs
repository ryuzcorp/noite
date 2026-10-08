//! Pull-request rows (F4): PRs, their conversation, reviews and the per-app
//! branch protection rule. Pure SQL plus the small pure helpers the approval
//! and head-move rules ride on; the policy lives in `service::prs`.

use std::collections::HashMap;

use sqlx::{FromRow, SqlitePool};

use crate::models::{new_id, now_iso};

/// Columns every `pull_request` query selects, in struct order.
pub const PR_COLS: &str = "id, app_id, number, title, body, author_id, base, head, state, \
     head_sha, merge_sha, merged_by, closed_by, created_at, updated_at, closed_at, merged_at";

#[derive(Debug, Clone, FromRow)]
pub struct PullRequestRow {
    pub id: String,
    pub app_id: String,
    pub number: i64,
    pub title: String,
    pub body: String,
    pub author_id: String,
    pub base: String,
    pub head: String,
    pub state: String,
    pub head_sha: String,
    pub merge_sha: Option<String>,
    pub merged_by: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub closed_at: Option<String>,
    pub merged_at: Option<String>,
}

#[derive(Debug, Clone, FromRow)]
pub struct PrCommentRow {
    pub id: String,
    pub pr_id: String,
    pub author_id: String,
    pub body: String,
    pub path: Option<String>,
    pub line: Option<i64>,
    pub side: Option<String>,
    pub commit_sha: Option<String>,
    pub created_at: String,
    pub edited_at: Option<String>,
}

#[derive(Debug, Clone, FromRow)]
pub struct PrReviewRow {
    pub id: String,
    pub reviewer_id: String,
    pub state: String,
    pub commit_sha: String,
    pub created_at: String,
    pub dismissed_at: Option<String>,
}

/// The protection rule for one app; the column defaults when no row exists.
#[derive(Debug, Clone, Default, PartialEq, Eq, FromRow)]
pub struct BranchRulesRow {
    pub require_pr: i64,
    pub required_approvals: i64,
}

/// Insert a new PR. `number` is the caller's (`next_number`), so a lost race
/// surfaces as the `UNIQUE(app_id, number)` (or the open-pair) violation.
#[allow(clippy::too_many_arguments)]
pub async fn insert_pr(
    pool: &SqlitePool,
    app_id: &str,
    number: i64,
    title: &str,
    body: &str,
    author_id: &str,
    base: &str,
    head: &str,
    head_sha: &str,
) -> sqlx::Result<PullRequestRow> {
    let now = now_iso();
    let id = new_id();
    sqlx::query(
        "INSERT INTO pull_request \
         (id, app_id, number, title, body, author_id, base, head, state, head_sha, \
          created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)",
    )
    .bind(&id)
    .bind(app_id)
    .bind(number)
    .bind(title)
    .bind(body)
    .bind(author_id)
    .bind(base)
    .bind(head)
    .bind(head_sha)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(PullRequestRow {
        id,
        app_id: app_id.to_string(),
        number,
        title: title.to_string(),
        body: body.to_string(),
        author_id: author_id.to_string(),
        base: base.to_string(),
        head: head.to_string(),
        state: "open".to_string(),
        head_sha: head_sha.to_string(),
        merge_sha: None,
        merged_by: None,
        created_at: now.clone(),
        updated_at: now,
        closed_at: None,
        merged_at: None,
    })
}

/// The next per-app number: MAX + 1.
pub async fn next_number(pool: &SqlitePool, app_id: &str) -> sqlx::Result<i64> {
    let max: Option<i64> =
        sqlx::query_scalar("SELECT MAX(number) FROM pull_request WHERE app_id = ?")
            .bind(app_id)
            .fetch_one(pool)
            .await?;
    Ok(max.unwrap_or(0) + 1)
}

pub async fn get_pr(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<PullRequestRow>> {
    let sql = format!("SELECT {PR_COLS} FROM pull_request WHERE id = ?");
    sqlx::query_as::<_, PullRequestRow>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn get_by_number(
    pool: &SqlitePool,
    app_id: &str,
    number: i64,
) -> sqlx::Result<Option<PullRequestRow>> {
    let sql = format!("SELECT {PR_COLS} FROM pull_request WHERE app_id = ? AND number = ?");
    sqlx::query_as::<_, PullRequestRow>(&sql)
        .bind(app_id)
        .bind(number)
        .fetch_optional(pool)
        .await
}

/// An open PR for the pair, if any (the duplicate check and reopen guard).
pub async fn open_for_pair(
    pool: &SqlitePool,
    app_id: &str,
    base: &str,
    head: &str,
) -> sqlx::Result<Option<PullRequestRow>> {
    let sql = format!(
        "SELECT {PR_COLS} FROM pull_request \
         WHERE app_id = ? AND base = ? AND head = ? AND state = 'open'"
    );
    sqlx::query_as::<_, PullRequestRow>(&sql)
        .bind(app_id)
        .bind(base)
        .bind(head)
        .fetch_optional(pool)
        .await
}

/// Newest first, optionally filtered by state, paged.
pub async fn list_prs(
    pool: &SqlitePool,
    app_id: &str,
    state: Option<&str>,
    skip: i64,
    limit: i64,
) -> sqlx::Result<Vec<PullRequestRow>> {
    let sql = match state {
        Some(_) => format!(
            "SELECT {PR_COLS} FROM pull_request WHERE app_id = ? AND state = ? \
             ORDER BY number DESC LIMIT ? OFFSET ?"
        ),
        None => format!(
            "SELECT {PR_COLS} FROM pull_request WHERE app_id = ? \
             ORDER BY number DESC LIMIT ? OFFSET ?"
        ),
    };
    let mut query = sqlx::query_as::<_, PullRequestRow>(&sql).bind(app_id);
    if let Some(state) = state {
        query = query.bind(state);
    }
    query.bind(limit).bind(skip).fetch_all(pool).await
}

/// `(open, closed, merged)` counts for one app's filter chips.
pub async fn counts(pool: &SqlitePool, app_id: &str) -> sqlx::Result<(i64, i64, i64)> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT state, COUNT(*) FROM pull_request WHERE app_id = ? GROUP BY state",
    )
    .bind(app_id)
    .fetch_all(pool)
    .await?;
    let mut counts = (0, 0, 0);
    for (state, count) in rows {
        match state.as_str() {
            "open" => counts.0 = count,
            "closed" => counts.1 = count,
            "merged" => counts.2 = count,
            _ => {}
        }
    }
    Ok(counts)
}

/// Comment counts for every PR of one app, keyed by PR id.
pub async fn comment_counts(pool: &SqlitePool, app_id: &str) -> sqlx::Result<HashMap<String, i64>> {
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT pr_id, COUNT(*) FROM pr_comment \
         WHERE pr_id IN (SELECT id FROM pull_request WHERE app_id = ?) GROUP BY pr_id",
    )
    .bind(app_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().collect())
}

/// Update the editable fields; `None` leaves one alone. Always bumps
/// `updated_at`.
pub async fn update_pr(
    pool: &SqlitePool,
    id: &str,
    title: Option<&str>,
    body: Option<&str>,
) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE pull_request SET \
         title = COALESCE(?, title), body = COALESCE(?, body), updated_at = ? WHERE id = ?",
    )
    .bind(title)
    .bind(body)
    .bind(now_iso())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn close_pr(pool: &SqlitePool, id: &str, closed_by: &str) -> sqlx::Result<()> {
    let now = now_iso();
    sqlx::query(
        "UPDATE pull_request SET state = 'closed', closed_by = ?, closed_at = ?, updated_at = ? \
         WHERE id = ?",
    )
    .bind(closed_by)
    .bind(&now)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn reopen_pr(pool: &SqlitePool, id: &str) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE pull_request SET state = 'open', closed_by = NULL, closed_at = NULL, \
         updated_at = ? WHERE id = ?",
    )
    .bind(now_iso())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn merge_pr(pool: &SqlitePool, id: &str, merge_sha: &str, merged_by: &str) -> sqlx::Result<()> {
    let now = now_iso();
    sqlx::query(
        "UPDATE pull_request SET state = 'merged', merge_sha = ?, merged_by = ?, \
         merged_at = ?, closed_at = ?, closed_by = ?, updated_at = ? WHERE id = ?",
    )
    .bind(merge_sha)
    .bind(merged_by)
    .bind(&now)
    .bind(&now)
    .bind(merged_by)
    .bind(&now)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// The open PRs whose head branch is `head` (after a move, they carry the new
/// sha).
pub async fn open_prs_for_head(
    pool: &SqlitePool,
    app_id: &str,
    head: &str,
) -> sqlx::Result<Vec<PullRequestRow>> {
    let sql = format!(
        "SELECT {PR_COLS} FROM pull_request \
         WHERE app_id = ? AND head = ? AND state = 'open'"
    );
    sqlx::query_as::<_, PullRequestRow>(&sql)
        .bind(app_id)
        .bind(head)
        .fetch_all(pool)
        .await
}

/// Move every open PR whose head branch is `head` to `sha`. A no-op when the
/// sha is unchanged, so a re-push of the same tip never bumps `updated_at`.
pub async fn move_heads(pool: &SqlitePool, app_id: &str, head: &str, sha: &str) -> sqlx::Result<u64> {
    let res = sqlx::query(
        "UPDATE pull_request SET head_sha = ?, updated_at = ? \
         WHERE app_id = ? AND head = ? AND state = 'open' AND head_sha != ?",
    )
    .bind(sha)
    .bind(now_iso())
    .bind(app_id)
    .bind(head)
    .bind(sha)
    .execute(pool)
    .await?;
    Ok(res.rows_affected())
}

/// Dismiss every undismissed review recorded at a different sha than the
/// current head. Keyed on the sha, not the branch, so a force-move that lands
/// on an older commit dismisses too.
pub async fn dismiss_reviews_before(pool: &SqlitePool, pr_id: &str, head_sha: &str) -> sqlx::Result<()> {
    sqlx::query(
        "UPDATE pr_review SET dismissed_at = ? \
         WHERE pr_id = ? AND commit_sha != ? AND dismissed_at IS NULL",
    )
    .bind(now_iso())
    .bind(pr_id)
    .bind(head_sha)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn insert_comment(
    pool: &SqlitePool,
    pr_id: &str,
    author_id: &str,
    body: &str,
    target: Option<(&str, i64, &str, &str)>,
) -> sqlx::Result<PrCommentRow> {
    let id = new_id();
    let now = now_iso();
    let (path, line, side, commit_sha) = match target {
        Some((path, line, side, commit_sha)) => {
            (Some(path), Some(line), Some(side), Some(commit_sha))
        }
        None => (None, None, None, None),
    };
    sqlx::query(
        "INSERT INTO pr_comment \
         (id, pr_id, author_id, body, path, line, side, commit_sha, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(pr_id)
    .bind(author_id)
    .bind(body)
    .bind(path)
    .bind(line)
    .bind(side)
    .bind(commit_sha)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(PrCommentRow {
        id,
        pr_id: pr_id.to_string(),
        author_id: author_id.to_string(),
        body: body.to_string(),
        path: path.map(str::to_string),
        line,
        side: side.map(str::to_string),
        commit_sha: commit_sha.map(str::to_string),
        created_at: now,
        edited_at: None,
    })
}

pub async fn get_comment(pool: &SqlitePool, id: &str) -> sqlx::Result<Option<PrCommentRow>> {
    sqlx::query_as::<_, PrCommentRow>("SELECT * FROM pr_comment WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
}

pub async fn edit_comment(pool: &SqlitePool, id: &str, body: &str) -> sqlx::Result<()> {
    sqlx::query("UPDATE pr_comment SET body = ?, edited_at = ? WHERE id = ?")
        .bind(body)
        .bind(now_iso())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn delete_comment(pool: &SqlitePool, id: &str) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM pr_comment WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// The PR's comments, oldest first.
pub async fn list_comments(pool: &SqlitePool, pr_id: &str) -> sqlx::Result<Vec<PrCommentRow>> {
    sqlx::query_as::<_, PrCommentRow>(
        "SELECT * FROM pr_comment WHERE pr_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(pr_id)
    .fetch_all(pool)
    .await
}

pub async fn insert_review(
    pool: &SqlitePool,
    pr_id: &str,
    reviewer_id: &str,
    state: &str,
    commit_sha: &str,
) -> sqlx::Result<PrReviewRow> {
    let id = new_id();
    let now = now_iso();
    sqlx::query(
        "INSERT INTO pr_review (id, pr_id, reviewer_id, state, commit_sha, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(pr_id)
    .bind(reviewer_id)
    .bind(state)
    .bind(commit_sha)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(PrReviewRow {
        id,
        reviewer_id: reviewer_id.to_string(),
        state: state.to_string(),
        commit_sha: commit_sha.to_string(),
        created_at: now,
        dismissed_at: None,
    })
}

/// The PR's reviews, oldest first (the timeline order).
pub async fn list_reviews(pool: &SqlitePool, pr_id: &str) -> sqlx::Result<Vec<PrReviewRow>> {
    sqlx::query_as::<_, PrReviewRow>(
        "SELECT * FROM pr_review WHERE pr_id = ? ORDER BY created_at ASC, id ASC",
    )
    .bind(pr_id)
    .fetch_all(pool)
    .await
}

/// Requirement said there is no row until an admin saves one.
pub async fn branch_rules(pool: &SqlitePool, app_id: &str) -> sqlx::Result<BranchRulesRow> {
    let row: Option<BranchRulesRow> = sqlx::query_as(
        "SELECT require_pr, required_approvals FROM app_branch_rule WHERE app_id = ?",
    )
    .bind(app_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.unwrap_or_default())
}

pub async fn set_branch_rules(
    pool: &SqlitePool,
    app_id: &str,
    require_pr: bool,
    required_approvals: i64,
) -> sqlx::Result<BranchRulesRow> {
    sqlx::query(
        "INSERT INTO app_branch_rule (app_id, require_pr, required_approvals) VALUES (?, ?, ?) \
         ON CONFLICT(app_id) DO UPDATE SET require_pr = excluded.require_pr, \
         required_approvals = excluded.required_approvals",
    )
    .bind(app_id)
    .bind(i64::from(require_pr))
    .bind(required_approvals)
    .execute(pool)
    .await?;
    Ok(BranchRulesRow {
        require_pr: i64::from(require_pr),
        required_approvals,
    })
}
