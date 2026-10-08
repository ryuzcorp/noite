//! Pull requests (F4): the forge's own data and git work.
//!
//! A PR is a pair of same-repo branches (`base`, usually `main`, and `head`)
//! plus a conversation, reviews and approvals. Merging is always a squash:
//! `merge-tree` builds the tree, `commit-tree` writes one commit whose parent
//! is the base tip, and `publish_ref` publishes it exactly like a push — so a
//! merge into `main` deploys through the normal tip path.
//!
//! Policy lives here (the UI passes the caller's `role`): the push role may
//! open, comment, review and merge; only the author or an admin may edit a PR;
//! nobody approves their own; admins bypass `required_approvals`.

use std::collections::HashMap;

use serde::Serialize;
use ts_rs::TS;

use crate::db::prs::{self, PrCommentRow, PrReviewRow, PullRequestRow};
use crate::host::forge;
use crate::host::git_identity::{self, Actor};
use crate::host::prs as host_prs;
use crate::models::App;
use crate::api_error::ApiError;
use crate::service::apps::app_or_404;
use crate::AppState;

/// A PR as the list and detail pages show it.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PrSummary {
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
    pub comment_count: i64,
}

/// A comment. A line comment carries its anchor (`path`, `line`, `side` and
/// the `commit_sha` it was written against); `outdated` says that anchor no
/// longer matches the current diff.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PrComment {
    pub id: String,
    pub author_id: String,
    pub body: String,
    pub path: Option<String>,
    pub line: Option<i64>,
    pub side: Option<String>,
    pub commit_sha: Option<String>,
    pub created_at: String,
    pub edited_at: Option<String>,
    pub outdated: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PrReview {
    pub id: String,
    pub reviewer_id: String,
    pub state: String,
    pub commit_sha: String,
    pub created_at: String,
    pub dismissed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PrCounts {
    pub open: i64,
    pub closed: i64,
    pub merged: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PrList {
    pub pull_requests: Vec<PrSummary>,
    pub counts: PrCounts,
}

/// `mergeState` values the merge box renders.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PrDetail {
    pub pull_request: PrSummary,
    pub comments: Vec<PrComment>,
    pub reviews: Vec<PrReview>,
    /// The live `base..head` compare; `None` when the head branch is gone.
    pub compare: Option<forge::GitCompare>,
    pub approvals: i64,
    pub required_approvals: i64,
    pub require_pr: bool,
    pub merge_state: String,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BranchRules {
    pub require_pr: bool,
    pub required_approvals: i64,
}

/// An unknown ref is a 404, a malformed one a 400, a lost compare-and-swap a
/// 409 (the merge raced a push).
fn repo_error(e: anyhow::Error) -> ApiError {
    let msg = format!("{e:#}");
    if msg.contains("not found") {
        ApiError::not_found(msg)
    } else if msg.contains("invalid") {
        ApiError::bad(msg)
    } else if msg.contains("tip moved") {
        ApiError::conflict(msg)
    } else {
        ApiError::internal(msg)
    }
}

/// SQLite (and any other non-forge) failures: the message is what the client
/// needs, and there is no status to preserve.
fn internal_error(e: impl Into<anyhow::Error>) -> ApiError {
    ApiError::internal(format!("{:#}", e.into()))
}

/// The app plus its manifest-synced push mirror.
async fn app_repo(state: &AppState, id: &str) -> Result<(App, std::path::PathBuf), ApiError> {
    let app = app_or_404(state, id).await?;
    let bare = forge::read_mirror(state, &app.slug)
        .await
        .map_err(internal_error)?;
    Ok((app, bare))
}

fn summary(row: &PullRequestRow, comment_count: i64) -> PrSummary {
    PrSummary {
        number: row.number,
        title: row.title.clone(),
        body: row.body.clone(),
        author_id: row.author_id.clone(),
        base: row.base.clone(),
        head: row.head.clone(),
        state: row.state.clone(),
        head_sha: row.head_sha.clone(),
        merge_sha: row.merge_sha.clone(),
        merged_by: row.merged_by.clone(),
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
        closed_at: row.closed_at.clone(),
        merged_at: row.merged_at.clone(),
        comment_count,
    }
}

fn review_view(row: &PrReviewRow) -> PrReview {
    PrReview {
        id: row.id.clone(),
        reviewer_id: row.reviewer_id.clone(),
        state: row.state.clone(),
        commit_sha: row.commit_sha.clone(),
        created_at: row.created_at.clone(),
        dismissed_at: row.dismissed_at.clone(),
    }
}

/// Approvals that count: the latest review per reviewer, approved, not
/// dismissed, recorded at the current head, and not by the PR author.
pub fn counted_approvals(reviews: &[PrReview], head_sha: &str, author_id: &str) -> i64 {
    let mut latest: HashMap<&str, &PrReview> = HashMap::new();
    for review in reviews {
        let entry = latest.entry(review.reviewer_id.as_str()).or_insert(review);
        let newer = (review.created_at.as_str(), review.id.as_str())
            >= (entry.created_at.as_str(), entry.id.as_str());
        if newer {
            *entry = review;
        }
    }
    latest
        .values()
        .filter(|review| {
            review.state == "approved"
                && review.dismissed_at.is_none()
                && review.commit_sha == head_sha
                && review.reviewer_id != author_id
        })
        .count() as i64
}

/// The merge box state. Order: terminal states, then a missing head, then a
/// conflicting merge, then the approval gate.
fn merge_state(
    row: &PullRequestRow,
    head_known: bool,
    compare: Option<&forge::GitCompare>,
    approvals: i64,
    required: i64,
) -> String {
    if row.state == "merged" {
        return "merged".into();
    }
    if row.state == "closed" {
        return "closed".into();
    }
    if !head_known {
        return "head_missing".into();
    }
    match compare {
        Some(c) if c.mergeable => {
            if required > 0 && approvals < required {
                "blocked_approvals".into()
            } else {
                "mergeable".into()
            }
        }
        _ => "conflicts".into(),
    }
}

/// Whether a line comment's anchor changed since it was written. A `new`-side
/// comment anchors to the head version it was recorded at, so the diff
/// `commit_sha..head` decides; an `old`-side comment anchors to the merge base
/// version, so the current PR diff's old side decides.
async fn outdated_flags(
    bare: &std::path::Path,
    head_sha: &str,
    merge_base: Option<&str>,
    comments: &[PrCommentRow],
) -> HashMap<String, bool> {
    let mut flags = HashMap::new();
    let mut caches: HashMap<(String, String), HashMap<String, host_prs::HunkRanges>> = HashMap::new();
    for comment in comments {
        let Some(commit_sha) = comment.commit_sha.as_deref() else {
            continue;
        };
        let (Some(path), Some(line), Some(side)) = (&comment.path, comment.line, &comment.side)
        else {
            continue;
        };
        if commit_sha == head_sha {
            flags.insert(comment.id.clone(), false);
            continue;
        }
        let (from, to) = match side.as_str() {
            "new" => (commit_sha.to_string(), head_sha.to_string()),
            "old" => match merge_base {
                Some(base) if base != head_sha => (base.to_string(), head_sha.to_string()),
                _ => {
                    flags.insert(comment.id.clone(), false);
                    continue;
                }
            },
            _ => {
                flags.insert(comment.id.clone(), false);
                continue;
            }
        };
        let key = (from.clone(), to.clone());
        if !caches.contains_key(&key) {
            match host_prs::changed_ranges(bare, &from, &to).await {
                Ok(ranges) => {
                    caches.insert(key.clone(), ranges);
                }
                // The anchor commit is gone (force-move): the line cannot be
                // resolved, so the comment is outdated.
                Err(_) => {
                    flags.insert(comment.id.clone(), true);
                    continue;
                }
            }
        }
        let ranges = caches.get(&key);
        // `new`-side anchors live in the old version of the diff; `old`-side
        // anchors also live there (the merge base version).
        let changed = ranges
            .and_then(|files| files.get(path))
            .is_some_and(|ranges| host_prs::HunkRanges::covers(&ranges.old, line));
        flags.insert(comment.id.clone(), changed);
    }
    flags
}

/// Build the full detail (comments + reviews + live compare + merge state).
async fn detail(
    state: &AppState,
    app: &App,
    bare: &std::path::Path,
    row: PullRequestRow,
) -> Result<PrDetail, ApiError> {
    let rules = prs::branch_rules(&state.pool, &app.id)
        .await
        .map_err(internal_error)?;
    let comment_rows = prs::list_comments(&state.pool, &row.id)
        .await
        .map_err(internal_error)?;
    let review_rows = prs::list_reviews(&state.pool, &row.id)
        .await
        .map_err(internal_error)?;
    let reviews: Vec<PrReview> = review_rows.iter().map(review_view).collect();

    let compare = forge::compare(&state.config, &app.slug, bare, &row.base, &row.head)
        .await
        .ok();
    // The live head sha wins over the stored one (a best-effort sync could
    // have lagged a push); with no compare the head branch is gone.
    let head_known = compare.is_some();
    let head_sha = compare
        .as_ref()
        .map_or_else(|| row.head_sha.clone(), |c| c.head_sha.clone());
    let flags = outdated_flags(
        bare,
        &head_sha,
        compare.as_ref().and_then(|c| c.merge_base.as_deref()),
        &comment_rows,
    )
    .await;
    let comments = comment_rows
        .iter()
        .map(|comment| PrComment {
            id: comment.id.clone(),
            author_id: comment.author_id.clone(),
            body: comment.body.clone(),
            path: comment.path.clone(),
            line: comment.line,
            side: comment.side.clone(),
            commit_sha: comment.commit_sha.clone(),
            created_at: comment.created_at.clone(),
            edited_at: comment.edited_at.clone(),
            outdated: flags.get(&comment.id).copied().unwrap_or(false),
        })
        .collect();
    let approvals = counted_approvals(&reviews, &head_sha, &row.author_id);
    let state_name = merge_state(
        &row,
        head_known,
        compare.as_ref(),
        approvals,
        rules.required_approvals,
    );
    Ok(PrDetail {
        pull_request: summary(&row, comment_rows.len() as i64),
        comments,
        reviews,
        compare,
        approvals,
        required_approvals: rules.required_approvals,
        require_pr: rules.require_pr != 0,
        merge_state: state_name,
    })
}

/// Newest first, with the filter counts.
pub async fn list(
    state: &AppState,
    id: &str,
    state_filter: Option<&str>,
    skip: i64,
    limit: i64,
) -> Result<PrList, ApiError> {
    let state_filter = match state_filter {
        Some("all") | None => None,
        Some(other) => {
            if !matches!(other, "open" | "closed" | "merged") {
                return Err(ApiError::bad(format!("unknown state {other:?}")));
            }
            Some(other)
        }
    };
    let app = app_or_404(state, id).await?;
    let skip = skip.max(0);
    let limit = limit.clamp(1, 100);
    let rows = prs::list_prs(&state.pool, &app.id, state_filter, skip, limit)
        .await
        .map_err(internal_error)?;
    let counts_by_pr = prs::comment_counts(&state.pool, &app.id)
        .await
        .map_err(internal_error)?;
    let (open, closed, merged) = prs::counts(&state.pool, &app.id)
        .await
        .map_err(internal_error)?;
    Ok(PrList {
        pull_requests: rows
            .iter()
            .map(|row| summary(row, counts_by_pr.get(&row.id).copied().unwrap_or(0)))
            .collect(),
        counts: PrCounts {
            open,
            closed,
            merged,
        },
    })
}

pub async fn get(state: &AppState, id: &str, number: i64) -> Result<PrDetail, ApiError> {
    let (app, bare) = app_repo(state, id).await?;
    let row = prs::get_by_number(&state.pool, &app.id, number)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApiError::not_found(format!("pull request #{number} not found")))?;
    detail(state, &app, &bare, row).await
}

/// Open a PR. Both branches must exist, they must differ, and only one open
/// PR may exist for the pair.
pub async fn create(
    state: &AppState,
    id: &str,
    actor: &Actor,
    title: &str,
    body: &str,
    base: &str,
    head: &str,
) -> Result<PrDetail, ApiError> {
    let title = title.trim();
    if title.is_empty() {
        return Err(ApiError::bad("title is required"));
    }
    if !forge::valid_branch_name(base) || !forge::valid_branch_name(head) {
        return Err(ApiError::bad("invalid branch name"));
    }
    if base == head {
        return Err(ApiError::bad("head and base must be different branches"));
    }
    let (app, bare) = app_repo(state, id).await?;
    let head_sha = forge::resolve_ref(&bare, head)
        .await
        .map_err(|_| ApiError::not_found(format!("branch {head:?} not found")))?;
    forge::resolve_ref(&bare, base)
        .await
        .map_err(|_| ApiError::not_found(format!("branch {base:?} not found")))?;
    if prs::open_for_pair(&state.pool, &app.id, base, head)
        .await
        .map_err(internal_error)?
        .is_some()
    {
        return Err(ApiError::conflict(format!(
            "an open pull request already exists for {head} → {base}"
        )));
    }
    let number = prs::next_number(&state.pool, &app.id)
        .await
        .map_err(internal_error)?;
    let row = prs::insert_pr(
        &state.pool,
        &app.id,
        number,
        title,
        body,
        &actor.user_id,
        base,
        head,
        &head_sha,
    )
    .await
    .map_err(|e| ApiError::conflict(format!("could not open the pull request: {e}")))?;
    detail(state, &app, &bare, row).await
}

/// Edit title/body (author or admin) and close/reopen.
#[allow(clippy::too_many_arguments)]
pub async fn update(
    state: &AppState,
    id: &str,
    number: i64,
    actor: &Actor,
    role: &str,
    title: Option<&str>,
    body: Option<&str>,
    next_state: Option<&str>,
) -> Result<PrDetail, ApiError> {
    let (app, bare) = app_repo(state, id).await?;
    let row = prs::get_by_number(&state.pool, &app.id, number)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApiError::not_found(format!("pull request #{number} not found")))?;
    if actor.user_id != row.author_id && role != "admin" {
        return Err(ApiError::bad("only the author or an admin may edit this pull request"));
    }
    if let Some(title) = title {
        if title.trim().is_empty() {
            return Err(ApiError::bad("title is required"));
        }
    }
    if title.is_some() || body.is_some() {
        prs::update_pr(&state.pool, &row.id, title, body)
            .await
            .map_err(internal_error)?;
    }
    match next_state {
        None => {}
        Some("closed") => {
            if row.state == "open" {
                prs::close_pr(&state.pool, &row.id, &actor.user_id)
                    .await
                    .map_err(internal_error)?;
            }
        }
        Some("open") => {
            if row.state == "closed" {
                if forge::resolve_ref(&bare, &row.head).await.is_err() {
                    return Err(ApiError::conflict(
                        "the head branch no longer exists; push it again before reopening",
                    ));
                }
                if prs::open_for_pair(&state.pool, &app.id, &row.base, &row.head)
                    .await
                    .map_err(internal_error)?
                    .is_some()
                {
                    return Err(ApiError::conflict(
                        "another open pull request already targets that branch",
                    ));
                }
                prs::reopen_pr(&state.pool, &row.id)
                    .await
                    .map_err(internal_error)?;
            }
        }
        Some(other) => return Err(ApiError::bad(format!("cannot set state {other:?} directly"))),
    }
    get(state, id, number).await
}

/// Add a comment; a line comment needs the full anchor (path, line, side and
/// the commit it was written against).
#[allow(clippy::too_many_arguments)]
pub async fn comment(
    state: &AppState,
    id: &str,
    number: i64,
    actor: &Actor,
    role: &str,
    body: &str,
    path: Option<&str>,
    line: Option<i64>,
    side: Option<&str>,
    commit_sha: Option<&str>,
) -> Result<PrComment, ApiError> {
    if role == "view" {
        return Err(ApiError::bad("viewers may not comment"));
    }
    if body.trim().is_empty() {
        return Err(ApiError::bad("a comment needs a body"));
    }
    let app = app_or_404(state, id).await?;
    let row = prs::get_by_number(&state.pool, &app.id, number)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApiError::not_found(format!("pull request #{number} not found")))?;
    let anchored = path.is_some() || line.is_some() || side.is_some() || commit_sha.is_some();
    let target_ref = if anchored {
        let (Some(path), Some(line), Some(side), Some(commit_sha)) =
            (path, line, side, commit_sha)
        else {
            return Err(ApiError::bad(
                "a line comment needs path, line, side and commitSha",
            ));
        };
        if !matches!(side, "old" | "new") {
            return Err(ApiError::bad("side must be 'old' or 'new'"));
        }
        if line < 1 {
            return Err(ApiError::bad("line must be positive"));
        }
        if path.is_empty() {
            return Err(ApiError::bad("a line comment needs a path"));
        }
        Some((path, line, side, commit_sha))
    } else {
        None
    };
    let stored = prs::insert_comment(&state.pool, &row.id, &actor.user_id, body, target_ref)
        .await
        .map_err(internal_error)?;
    Ok(PrComment {
        id: stored.id,
        author_id: stored.author_id,
        body: stored.body,
        path: stored.path,
        line: stored.line,
        side: stored.side,
        commit_sha: stored.commit_sha,
        created_at: stored.created_at,
        edited_at: stored.edited_at,
        outdated: false,
    })
}

/// Edit one's own comment.
pub async fn comment_edit(
    state: &AppState,
    id: &str,
    comment_id: &str,
    actor: &Actor,
    body: &str,
) -> Result<(), ApiError> {
    if body.trim().is_empty() {
        return Err(ApiError::bad("a comment needs a body"));
    }
    let row = owned_comment(state, id, comment_id, actor).await?;
    prs::edit_comment(&state.pool, &row.id, body)
        .await
        .map_err(internal_error)
}

/// Delete one's own comment; an admin may delete any.
pub async fn comment_delete(
    state: &AppState,
    id: &str,
    comment_id: &str,
    actor: &Actor,
    role: &str,
) -> Result<(), ApiError> {
    let app = app_or_404(state, id).await?;
    let comment = prs::get_comment(&state.pool, comment_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApiError::not_found("comment not found"))?;
    let pr = prs::get_pr(&state.pool, &comment.pr_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApiError::not_found("pull request not found"))?;
    if pr.app_id != app.id {
        return Err(ApiError::not_found("comment not found"));
    }
    if comment.author_id != actor.user_id && role != "admin" {
        return Err(ApiError::bad("only the author or an admin may delete this comment"));
    }
    prs::delete_comment(&state.pool, &comment.id)
        .await
        .map_err(internal_error)
}

async fn owned_comment(
    state: &AppState,
    id: &str,
    comment_id: &str,
    actor: &Actor,
) -> Result<PrCommentRow, ApiError> {
    let app = app_or_404(state, id).await?;
    let comment = prs::get_comment(&state.pool, comment_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApiError::not_found("comment not found"))?;
    let pr = prs::get_pr(&state.pool, &comment.pr_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApiError::not_found("pull request not found"))?;
    if pr.app_id != app.id || comment.author_id != actor.user_id {
        return Err(ApiError::bad("only the author may edit this comment"));
    }
    Ok(comment)
}

/// Approve or request changes at the current head. Never the PR author.
pub async fn review(
    state: &AppState,
    id: &str,
    number: i64,
    actor: &Actor,
    role: &str,
    review_state: &str,
) -> Result<PrDetail, ApiError> {
    if role == "view" {
        return Err(ApiError::bad("viewers may not review"));
    }
    if !matches!(review_state, "approved" | "changes_requested") {
        return Err(ApiError::bad("state must be 'approved' or 'changes_requested'"));
    }
    let (app, bare) = app_repo(state, id).await?;
    let row = prs::get_by_number(&state.pool, &app.id, number)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApiError::not_found(format!("pull request #{number} not found")))?;
    if row.state != "open" {
        return Err(ApiError::conflict("this pull request is not open"));
    }
    if row.author_id == actor.user_id {
        return Err(ApiError::bad("you cannot review your own pull request"));
    }
    let head_sha = forge::resolve_ref(&bare, &row.head)
        .await
        .map_err(|_| ApiError::conflict("the head branch no longer exists"))?;
    prs::insert_review(&state.pool, &row.id, &actor.user_id, review_state, &head_sha)
        .await
        .map_err(internal_error)?;
    detail(state, &app, &bare, row).await
}

/// Squash-merge: `merge-tree` → `commit-tree` → `publish_ref` with the base
/// tip as the compare-and-swap.
#[allow(clippy::too_many_arguments)]
pub async fn merge(
    state: &AppState,
    id: &str,
    number: i64,
    actor: &Actor,
    role: &str,
    author_name: Option<&str>,
    title: Option<&str>,
    message: Option<&str>,
    delete_branch: bool,
) -> Result<PrDetail, ApiError> {
    if role == "view" {
        return Err(ApiError::bad("viewers may not merge"));
    }
    let (app, bare) = app_repo(state, id).await?;
    let row = prs::get_by_number(&state.pool, &app.id, number)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApiError::not_found(format!("pull request #{number} not found")))?;
    if row.state != "open" {
        return Err(ApiError::conflict("this pull request is not open"));
    }
    let rules = prs::branch_rules(&state.pool, &app.id)
        .await
        .map_err(internal_error)?;

    let base_sha = forge::resolve_ref(&bare, &row.base)
        .await
        .map_err(|_| ApiError::conflict(format!("base branch {:?} is gone", row.base)))?;
    let head_sha = forge::resolve_ref(&bare, &row.head)
        .await
        .map_err(|_| ApiError::conflict(format!("head branch {:?} is gone", row.head)))?;

    if rules.required_approvals > 0 && role != "admin" {
        let reviews: Vec<PrReview> = prs::list_reviews(&state.pool, &row.id)
            .await
            .map_err(internal_error)?
            .iter()
            .map(review_view)
            .collect();
        let approvals = counted_approvals(&reviews, &head_sha, &row.author_id);
        if approvals < rules.required_approvals {
            return Err(ApiError::conflict(format!(
                "needs {} approving review(s); {approvals} counted",
                rules.required_approvals
            )));
        }
    }

    let merged = forge::merge_tree(&state.config, &app.slug, &base_sha, &head_sha)
        .await
        .map_err(repo_error)?;
    let Some(tree) = merged.tree else {
        return Err(ApiError::conflict(format!(
            "merge conflicts: {} — resolve them locally",
            merged.conflicts.join(", ")
        )));
    };

    let title = title.map(str::trim).filter(|t| !t.is_empty()).unwrap_or(&row.title);
    let commit_message = squash_message(&bare, title, number, &base_sha, &head_sha, message).await;
    let author = git_identity::noreply(&state.config, &row.author_id, author_name.unwrap_or_default());
    let committer = git_identity::noreply(&state.config, &actor.user_id, &actor.name);
    let merge_sha = host_prs::squash_commit(
        &bare,
        &tree,
        &base_sha,
        &author,
        &committer,
        &commit_message,
    )
    .await
    .map_err(repo_error)?;

    forge::publish_ref(state, &app, &row.base, Some(&base_sha), Some(&merge_sha))
        .await
        .map_err(|e| {
            let msg = format!("{e:#}");
            if msg.contains("tip moved") {
                ApiError::conflict("the base branch moved; retry the merge")
            } else {
                repo_error(e)
            }
        })?;
    prs::merge_pr(&state.pool, &row.id, &merge_sha, &actor.user_id)
        .await
        .map_err(internal_error)?;
    if delete_branch {
        if let Err(e) = forge::publish_ref(state, &app, &row.head, Some(&head_sha), None).await {
            tracing::warn!(error = %format!("{e:#}"), "pr head delete after merge");
        }
    }
    get(state, id, number).await
}

/// `<title> (#<number>)`, a blank line, then the caller's message or the bullet
/// list of the branch's commit subjects.
async fn squash_message(
    bare: &std::path::Path,
    title: &str,
    number: i64,
    base_sha: &str,
    head_sha: &str,
    message: Option<&str>,
) -> String {
    let body = match message.map(str::trim).filter(|m| !m.is_empty()) {
        Some(message) => message.to_string(),
        None => {
            let range = format!("{base_sha}..{head_sha}");
            match forge::git_out(bare, &["log", "--format=%s", &range]).await {
                Ok(out) => {
                    let mut subjects: Vec<&str> = out
                        .lines()
                        .map(str::trim)
                        .filter(|line| !line.is_empty())
                        .collect();
                    subjects.reverse();
                    subjects
                        .iter()
                        .map(|subject| format!("- {subject}"))
                        .collect::<Vec<_>>()
                        .join("\n")
                }
                Err(e) => {
                    tracing::warn!(error = %format!("{e:#}"), "pr merge default message");
                    String::new()
                }
            }
        }
    };
    if body.is_empty() {
        format!("{title} (#{number})")
    } else {
        format!("{title} (#{number})\n\n{body}")
    }
}

pub async fn branch_rules_get(state: &AppState, id: &str) -> Result<BranchRules, ApiError> {
    let app = app_or_404(state, id).await?;
    let rules = prs::branch_rules(&state.pool, &app.id)
        .await
        .map_err(internal_error)?;
    Ok(BranchRules {
        require_pr: rules.require_pr != 0,
        required_approvals: rules.required_approvals,
    })
}

pub async fn branch_rules_set(
    state: &AppState,
    id: &str,
    require_pr: bool,
    required_approvals: i64,
) -> Result<BranchRules, ApiError> {
    if !(0..=2).contains(&required_approvals) {
        return Err(ApiError::bad("required approvals must be 0, 1 or 2"));
    }
    let app = app_or_404(state, id).await?;
    let rules = prs::set_branch_rules(&state.pool, &app.id, require_pr, required_approvals)
        .await
        .map_err(internal_error)?;
    Ok(BranchRules {
        require_pr: rules.require_pr != 0,
        required_approvals: rules.required_approvals,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn review(id: &str, reviewer: &str, state: &str, sha: &str, at: &str) -> PrReview {
        PrReview {
            id: id.into(),
            reviewer_id: reviewer.into(),
            state: state.into(),
            commit_sha: sha.into(),
            created_at: at.into(),
            dismissed_at: None,
        }
    }

    #[test]
    fn approvals_count_latest_per_reviewer_on_head_only() {
        let head = "aaaa";
        let reviews = vec![
            review("1", "a", "approved", head, "2026-01-01T00:00:00Z"),
            // A later review by `a` replaces the approval.
            review("2", "a", "changes_requested", head, "2026-01-02T00:00:00Z"),
            review("3", "b", "approved", head, "2026-01-01T00:00:00Z"),
            // An approval on an older sha does not count.
            review("4", "c", "approved", "bbbb", "2026-01-03T00:00:00Z"),
        ];
        assert_eq!(counted_approvals(&reviews, head, "author"), 1);
        // The author's own approval is excluded.
        let mut with_author = reviews.clone();
        with_author.push(review("5", "author", "approved", head, "2026-01-04T00:00:00Z"));
        assert_eq!(counted_approvals(&with_author, head, "author"), 1);
        // A dismissed approval does not count.
        let mut dismissed = reviews.clone();
        dismissed.push(PrReview {
            dismissed_at: Some("2026-01-05T00:00:00Z".into()),
            ..review("6", "d", "approved", head, "2026-01-01T00:00:00Z")
        });
        assert_eq!(counted_approvals(&dismissed, head, "author"), 1);
    }

    #[test]
    fn merge_state_precedence() {
        let mut row = PullRequestRow {
            id: "p".into(),
            app_id: "a".into(),
            number: 1,
            title: "t".into(),
            body: String::new(),
            author_id: "u".into(),
            base: "main".into(),
            head: "feat".into(),
            state: "open".into(),
            head_sha: "aaaa".into(),
            merge_sha: None,
            merged_by: None,
            created_at: String::new(),
            updated_at: String::new(),
            closed_at: None,
            merged_at: None,
        };
        assert_eq!(merge_state(&row, false, None, 0, 0), "head_missing");
        row.state = "closed".into();
        assert_eq!(merge_state(&row, false, None, 0, 0), "closed");
        row.state = "merged".into();
        assert_eq!(merge_state(&row, false, None, 0, 0), "merged");
    }

    // ---- integration: real bare repos + an in-process S3 stub ----

    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Duration;

    use axum::body::Bytes;
    use axum::extract::{Path as AxiPath, Query, State as AxiState};
    use axum::http::StatusCode;
    use axum::response::{IntoResponse, Response};
    use axum::routing::get as axum_get;
    use tokio::sync::Mutex;

    use crate::db;
    use crate::host::exec;
    use crate::models::new_id;

    type Store = Arc<Mutex<HashMap<String, Vec<u8>>>>;

    async fn put_object(
        AxiState(store): AxiState<Store>,
        AxiPath((bucket, key)): AxiPath<(String, String)>,
        body: Bytes,
    ) -> StatusCode {
        store
            .lock()
            .await
            .insert(format!("{bucket}/{key}"), body.to_vec());
        StatusCode::OK
    }

    async fn get_object(
        AxiState(store): AxiState<Store>,
        AxiPath((bucket, key)): AxiPath<(String, String)>,
    ) -> Response {
        match store.lock().await.get(&format!("{bucket}/{key}")) {
            Some(bytes) => (StatusCode::OK, bytes.clone()).into_response(),
            None => (
                StatusCode::NOT_FOUND,
                "<?xml version=\"1.0\"?><Error><Code>NoSuchKey</Code><Message>missing</Message></Error>",
            )
                .into_response(),
        }
    }

    async fn delete_object(
        AxiState(store): AxiState<Store>,
        AxiPath((bucket, key)): AxiPath<(String, String)>,
    ) -> StatusCode {
        store.lock().await.remove(&format!("{bucket}/{key}"));
        StatusCode::NO_CONTENT
    }

    async fn list_objects(
        AxiState(store): AxiState<Store>,
        AxiPath(bucket): AxiPath<String>,
        Query(q): Query<HashMap<String, String>>,
    ) -> Response {
        let prefix = q.get("prefix").cloned().unwrap_or_default();
        let store = store.lock().await;
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\
             <ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
        );
        xml.push_str(&format!(
            "<Name>{bucket}</Name><Prefix>{prefix}</Prefix>\
             <KeyCount>{}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>",
            store.len()
        ));
        for (full, bytes) in store.iter() {
            let Some(key) = full.strip_prefix(&format!("{bucket}/")) else {
                continue;
            };
            if !key.starts_with(&prefix) {
                continue;
            }
            xml.push_str(&format!(
                "<Contents><Key>{key}</Key>\
                 <LastModified>2026-01-01T00:00:00.000Z</LastModified>\
                 <ETag>\"e\"</ETag><Size>{}</Size><StorageClass>STANDARD</StorageClass></Contents>",
                bytes.len()
            ));
        }
        xml.push_str("</ListBucketResult>");
        (StatusCode::OK, xml).into_response()
    }

    async fn delete_objects(
        AxiState(store): AxiState<Store>,
        AxiPath(bucket): AxiPath<String>,
        body: Bytes,
    ) -> Response {
        let text = String::from_utf8_lossy(&body);
        let mut store = store.lock().await;
        for key in text
            .split("<Key>")
            .skip(1)
            .filter_map(|rest| rest.split("</Key>").next())
        {
            store.remove(&format!("{bucket}/{key}"));
        }
        (
            StatusCode::OK,
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?><DeleteResult></DeleteResult>",
        )
            .into_response()
    }

    async fn spawn_s3_stub() -> String {
        let store: Store = Arc::new(Mutex::new(HashMap::new()));
        let bucket_routes = || axum_get(list_objects).post(delete_objects);
        let app = axum::Router::new()
            .route("/{bucket}", bucket_routes())
            .route("/{bucket}/", bucket_routes())
            .route(
                "/{bucket}/{*key}",
                axum_get(get_object).put(put_object).delete(delete_object),
            )
            .with_state(store);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind s3 stub");
        let addr = listener.local_addr().expect("stub addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}")
    }

    const GIT_ENV: &[(&str, &str)] = &[
        ("GIT_AUTHOR_NAME", "Test"),
        ("GIT_AUTHOR_EMAIL", "test@example.com"),
        ("GIT_COMMITTER_NAME", "Test"),
        ("GIT_COMMITTER_EMAIL", "test@example.com"),
    ];

    async fn git(dir: &Path, args: &[&str]) -> String {
        exec::run_cmd("git", args, Some(dir), GIT_ENV, Duration::from_secs(30))
            .await
            .unwrap_or_else(|e| panic!("git {args:?} in {}: {e:#}", dir.display()))
    }

    struct Harness {
        state: AppState,
        app: App,
        dir: PathBuf,
        _tip_rx: crate::host::tips::TipReceiver,
    }

    impl Harness {
        async fn new(slug: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("noite-prs-{}", new_id()));
            std::fs::create_dir_all(&dir).expect("temp dir");
            let s3 = spawn_s3_stub().await;
            let mut cfg = crate::config::config_for_tests();
            cfg.database_url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
            cfg.s3_endpoint = s3.clone();
            cfg.s3_public_endpoint = s3;
            cfg.base_domain = "noite.test".to_string();
            cfg.work_dir = dir.join("work").to_string_lossy().into_owned();
            let config = Arc::new(cfg);
            let pool = crate::db::connect(&config.database_url)
                .await
                .expect("connect db");
            let (tip_tx, tip_rx) = crate::host::tips::channel();
            let (log_notify, _log_rx) = tokio::sync::watch::channel(0u64);
            let state = AppState {
                pool,
                config: config.clone(),
                procs: crate::host::supervisor::new_procs(),
                logs: crate::host::logs::new_state(),
                deploying: crate::host::deploy::new_deploying(),
                log_notify,
                git_sync: crate::host::git_manifest::GitSync::default(),
                tip_tx,
                ready: Arc::new(std::sync::atomic::AtomicBool::new(true)),
                isolation: Arc::new(tokio::sync::RwLock::new(
                    crate::host::isolation::IsolationStatus::default(),
                )),
                state_sync: crate::host::state::StateSync::new(),
                bucket_ok: Arc::new(tokio::sync::RwLock::new((
                    true,
                    String::new(),
                    std::time::Instant::now(),
                ))),
                started_at: chrono::Utc::now(),
            };
            let app = db::create_app(
                &state.pool,
                &config,
                db::NewApp {
                    name: slug,
                    slug,
                    user_id: "user_owner",
                    subdomain: &format!("{slug}.localhost"),
                    listen: 0,
                    internal: 0,
                },
            )
            .await
            .expect("app row");
            Self {
                state,
                app,
                dir,
                _tip_rx: tip_rx,
            }
        }

        /// A bare push mirror at the canonical path, HEAD on `main`.
        async fn mirror(&self) -> PathBuf {
            let bare = crate::host::git_http::http_bare(&self.state.config, &self.app.slug);
            let root = exec::work_root(&self.state.config);
            std::fs::create_dir_all(&root).expect("work root");
            std::fs::create_dir_all(bare.parent().expect("parent")).expect("mirror parent");
            git(
                &root,
                &[
                    "init",
                    "--bare",
                    "--initial-branch=main",
                    bare.to_str().expect("mirror path"),
                ],
            )
            .await;
            bare
        }

        async fn finish(self) {
            self.state.pool.close().await;
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// A scratch worktree that pushes into the mirror.
    struct Work {
        dir: PathBuf,
    }

    impl Work {
        async fn new(dir: &Path) -> Self {
            std::fs::create_dir_all(dir).expect("work dir");
            git(dir, &["init", "-q", "--initial-branch=main", "."]).await;
            Self {
                dir: dir.to_path_buf(),
            }
        }

        fn write(&self, path: &str, content: &str) {
            let full = self.dir.join(path);
            if let Some(parent) = full.parent() {
                std::fs::create_dir_all(parent).expect("file parent");
            }
            std::fs::write(full, content).expect("write");
        }

        async fn commit(&self, message: &str) -> String {
            git(&self.dir, &["add", "-A"]).await;
            git(&self.dir, &["commit", "-qm", message]).await;
            git(&self.dir, &["rev-parse", "HEAD"]).await.trim().to_string()
        }

        async fn branch(&self, name: &str, start: &str) {
            git(&self.dir, &["checkout", "-q", "-B", name, start]).await;
        }
    }

    /// Copy every branch of `work` into the mirror's object store without
    /// moving a head ref, and return each branch tip.
    async fn seed_objects(bare: &Path, work: &Work) -> HashMap<String, String> {
        let source = work.dir.to_str().expect("work path");
        git(bare, &["fetch", "-q", source, "+refs/heads/*:refs/seed/*"]).await;
        let mut tips = HashMap::new();
        let out = git(bare, &["for-each-ref", "--format=%(refname)", "refs/seed/"]).await;
        for refname in out.lines().map(str::trim).filter(|line| !line.is_empty()) {
            let sha = git(bare, &["rev-parse", refname]).await.trim().to_string();
            if let Some(name) = refname.strip_prefix("refs/seed/") {
                tips.insert(name.to_string(), sha);
            }
        }
        for refname in tips.keys() {
            git(bare, &["update-ref", "-d", &format!("refs/seed/{refname}")]).await;
        }
        tips
    }

    fn actor(user_id: &str, name: &str) -> Actor {
        Actor {
            user_id: user_id.into(),
            name: name.into(),
        }
    }

    /// A clean feature branch: `main` has a.txt, `feat` adds b.txt.
    async fn clean_pair(h: &Harness, bare: &Path) -> (String, String) {
        let work = Work::new(&h.dir.join("scratch")).await;
        work.write("a.txt", "a\n");
        let base = work.commit("base").await;
        work.branch("feat", "main").await;
        work.write("b.txt", "b\n");
        let head = work.commit("add b").await;
        let _ = seed_objects(bare, &work).await;
        forge::publish_ref(&h.state, &h.app, "main", None, Some(&base))
            .await
            .expect("publish main");
        forge::publish_ref(&h.state, &h.app, "feat", None, Some(&head))
            .await
            .expect("publish feat");
        (base, head)
    }

    #[tokio::test]
    async fn head_move_dismisses_reviews() {
        let h = Harness::new("prmove").await;
        let app_id = h.app.id.clone();
        let pr = prs::insert_pr(
            &h.state.pool,
            &app_id,
            1,
            "t",
            "",
            "user_a",
            "main",
            "feat",
            "sha_a",
        )
        .await
        .expect("insert");
        prs::insert_review(&h.state.pool, &pr.id, "user_b", "approved", "sha_a")
            .await
            .expect("review");
        host_prs::on_branch_moved(&h.state, &app_id, "feat", "sha_b")
            .await
            .expect("move");
        let moved = prs::get_pr(&h.state.pool, &pr.id)
            .await
            .expect("get")
            .expect("row");
        assert_eq!(moved.head_sha, "sha_b");
        let reviews: Vec<PrReview> = prs::list_reviews(&h.state.pool, &pr.id)
            .await
            .expect("reviews")
            .iter()
            .map(review_view)
            .collect();
        assert!(reviews[0].dismissed_at.is_some(), "review dismissed");
        assert_eq!(counted_approvals(&reviews, "sha_b", "user_a"), 0);
        h.finish().await;
    }

    #[tokio::test]
    async fn deleting_an_app_cascades_pr_data() {
        let h = Harness::new("prcascade").await;
        let app_id = h.app.id.clone();
        let pr = prs::insert_pr(
            &h.state.pool,
            &app_id,
            1,
            "t",
            "",
            "user_a",
            "main",
            "feat",
            "sha",
        )
        .await
        .expect("insert");
        prs::insert_comment(&h.state.pool, &pr.id, "user_a", "hi", None)
            .await
            .expect("comment");
        prs::insert_comment(
            &h.state.pool,
            &pr.id,
            "user_a",
            "line",
            Some(("a.txt", 3, "new", "sha")),
        )
        .await
        .expect("line comment");
        prs::insert_review(&h.state.pool, &pr.id, "user_b", "approved", "sha")
            .await
            .expect("review");
        db::delete_app(&h.state.pool, &app_id).await.expect("delete");
        let prs_left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pull_request")
            .fetch_one(&h.state.pool)
            .await
            .expect("count prs");
        let comments: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pr_comment")
            .fetch_one(&h.state.pool)
            .await
            .expect("count comments");
        let reviews: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM pr_review")
            .fetch_one(&h.state.pool)
            .await
            .expect("count reviews");
        assert_eq!((prs_left, comments, reviews), (0, 0, 0));
        h.finish().await;
    }

    #[tokio::test]
    async fn squash_merge_commits_once_and_deletes_the_branch() {
        let h = Harness::new("prmerge").await;
        let bare = h.mirror().await;
        let (base, _head) = clean_pair(&h, &bare).await;
        let author = actor("user_author", "Author");
        let detail = create(&h.state, &h.app.id, &author, "Add b", "", "main", "feat")
            .await
            .expect("open");
        assert_eq!(detail.merge_state, "mergeable");
        let merger = actor("user_merger", "Merger");
        let merged = merge(
            &h.state,
            &h.app.id,
            1,
            &merger,
            "push",
            Some("Author"),
            None,
            None,
            true,
        )
        .await
        .expect("merge");
        assert_eq!(merged.merge_state, "merged");
        let merge_sha = merged.pull_request.merge_sha.clone().expect("merge sha");
        let tip = git(&bare, &["rev-parse", "main"]).await;
        assert_eq!(tip.trim(), merge_sha);
        // One parent: the base tip. Author/committer are the noreply pair.
        assert_eq!(git(&bare, &["log", "-1", "--format=%P", &merge_sha]).await.trim(), base);
        assert_eq!(
            git(&bare, &["log", "-1", "--format=%an <%ae>|%cn <%ce>", &merge_sha]).await.trim(),
            "Author <user_author@users.noreply.noite.test>|Merger <user_merger@users.noreply.noite.test>"
        );
        // The merged commit lands as a deployable tip.
        let refs = crate::host::git_http::list_refs(&bare).await.expect("refs");
        assert!(!refs.contains_key("refs/heads/feat"), "head branch deleted");
        h.finish().await;
    }

    #[tokio::test]
    async fn merge_refuses_conflicts() {
        let h = Harness::new("prconflict").await;
        let bare = h.mirror().await;
        let work = Work::new(&h.dir.join("scratch")).await;
        work.write("a.txt", "base\n");
        let base = work.commit("base").await;
        work.branch("feat", &base).await;
        work.write("a.txt", "feature\n");
        let head = work.commit("feature edit").await;
        work.branch("main", &base).await;
        work.write("a.txt", "main edit\n");
        let main_tip = work.commit("main edit").await;
        seed_objects(&bare, &work).await;
        forge::publish_ref(&h.state, &h.app, "main", None, Some(&main_tip))
            .await
            .expect("main");
        forge::publish_ref(&h.state, &h.app, "feat", None, Some(&head))
            .await
            .expect("feat");
        let author = actor("user_author", "Author");
        create(&h.state, &h.app.id, &author, "Conflicting", "", "main", "feat")
            .await
            .expect("open");
        let err = merge(
            &h.state,
            &h.app.id,
            1,
            &author,
            "push",
            Some("Author"),
            None,
            None,
            false,
        )
        .await
        .expect_err("conflict");
        match err {
            ApiError::Conflict(message) => {
                assert!(message.contains("resolve them locally"), "{message}");
            }
            other => panic!("expected conflict, got {other:?}"),
        }
        h.finish().await;
    }

    #[tokio::test]
    async fn merge_needs_approvals_unless_admin() {
        let h = Harness::new("prapprovals").await;
        let bare = h.mirror().await;
        clean_pair(&h, &bare).await;
        prs::set_branch_rules(&h.state.pool, &h.app.id, true, 2)
            .await
            .expect("rules");
        let author = actor("user_author", "Author");
        create(&h.state, &h.app.id, &author, "Add b", "", "main", "feat")
            .await
            .expect("open");
        let err = merge(
            &h.state,
            &h.app.id,
            1,
            &author,
            "push",
            Some("Author"),
            None,
            None,
            false,
        )
        .await
        .expect_err("blocked");
        assert!(matches!(err, ApiError::Conflict(_)));
        // An admin bypasses the approval gate.
        let admin = actor("user_admin", "Admin");
        merge(
            &h.state,
            &h.app.id,
            1,
            &admin,
            "admin",
            Some("Author"),
            None,
            None,
            false,
        )
        .await
        .expect("admin merges");
        h.finish().await;
    }

    #[tokio::test]
    async fn a_stale_base_is_a_conflict() {
        let h = Harness::new("prcas").await;
        let bare = h.mirror().await;
        let (base, _head) = clean_pair(&h, &bare).await;
        let stale = "1".repeat(40);
        let err = forge::publish_ref(&h.state, &h.app, "main", Some(&stale), Some(&base))
            .await
            .expect_err("stale");
        assert!(format!("{err:#}").contains("tip moved"), "{err:#}");
        assert!(matches!(repo_error(err), ApiError::Conflict(_)));
        h.finish().await;
    }

    #[tokio::test]
    async fn a_missing_head_branch_reads_as_head_missing() {
        let h = Harness::new("prmissing").await;
        let _ = h.mirror().await;
        prs::insert_pr(
            &h.state.pool,
            &h.app.id,
            1,
            "t",
            "",
            "user_a",
            "main",
            "gone",
            "deadbeef",
        )
        .await
        .expect("insert");
        let detail = get(&h.state, &h.app.id, 1).await.expect("get");
        assert_eq!(detail.merge_state, "head_missing");
        assert!(detail.compare.is_none());
        h.finish().await;
    }
}
