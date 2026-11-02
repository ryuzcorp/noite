//! Sandbox container images built from a Dockerfile (SPEC, Sandbox
//! containers).
//!
//! `celld deploy` runs as the runner against the host engine, so a
//! Dockerfile it builds would run its `RUN` steps on the host daemon,
//! outside celld's fence. Noite therefore builds only Dockerfiles that run
//! nothing: file and metadata instructions over base images that are
//! pulled from a registry, checked for `ONBUILD` triggers (which would run
//! during the build) and pinned by digest. That covers Void's default
//! Sandbox image (`FROM node` + `COPY --from=cloudflare/sandbox` of the
//! shim) and images that add files with `COPY`; anything that needs `RUN`
//! is published to a registry and referenced by name instead.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{bail, Context};

/// Instructions a build may use: none of them runs a process.
const ALLOWED: &[&str] = &[
    "FROM",
    "COPY",
    "WORKDIR",
    "ENV",
    "LABEL",
    "USER",
    "EXPOSE",
    "CMD",
    "ENTRYPOINT",
    "ARG",
    "STOPSIGNAL",
    "MAINTAINER",
];

/// `COPY` flags that only shape the copy.
const COPY_FLAGS: &[&str] = &[
    "--from",
    "--chown",
    "--chmod",
    "--link",
    "--parents",
    "--exclude",
];

/// A Dockerfile larger than this is refused unread (a real one is a few
/// hundred bytes).
const MAX_DOCKERFILE_BYTES: u64 = 64 * 1024;

/// Registry images one Dockerfile may read (each is pulled and vetted).
const MAX_IMAGES: usize = 8;

/// What `docker build` may send as the build context: it tars the whole
/// directory as root.
const MAX_CONTEXT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CONTEXT_FILES: usize = 20_000;

/// One logical instruction: its keyword and the rest of the line, with
/// continuations joined.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Instruction {
    keyword: String,
    args: String,
}

/// A checked Dockerfile: its instructions, and every image it reads from a
/// registry (each `FROM` base and `COPY --from` image that is not a stage),
/// in order of first use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    instructions: Vec<Instruction>,
    pub images: Vec<String>,
}

/// Split a Dockerfile into instructions: comments and blank lines dropped,
/// `\` continuations joined (comment lines inside a continuation are
/// skipped, as Docker does).
fn instructions(text: &str) -> anyhow::Result<Vec<Instruction>> {
    let mut out = Vec::new();
    let mut pending = String::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('#') {
            // Parser directives (`# syntax=`, `# escape=`, `# check=`) swap
            // the frontend or the escape character; `# syntax` alone runs an
            // arbitrary frontend image inside the builder.
            if pending.is_empty() && out.is_empty() && is_directive(line) {
                bail!("parser directive `{line}` is not supported");
            }
            continue;
        }
        if line.is_empty() && pending.is_empty() {
            continue;
        }
        if let Some(head) = line.strip_suffix('\\') {
            pending.push_str(head);
            pending.push(' ');
            continue;
        }
        pending.push_str(line);
        let joined = std::mem::take(&mut pending);
        let joined = joined.trim();
        if joined.is_empty() {
            continue;
        }
        let (keyword, args) = joined
            .split_once(char::is_whitespace)
            .unwrap_or((joined, ""));
        out.push(Instruction {
            keyword: keyword.to_ascii_uppercase(),
            args: args.trim().to_string(),
        });
    }
    if !pending.trim().is_empty() {
        bail!("the last instruction ends in a line continuation");
    }
    Ok(out)
}

fn is_directive(line: &str) -> bool {
    let body = line.trim_start_matches('#').trim();
    body.split_once('=').is_some_and(|(key, _)| {
        !key.is_empty() && key.trim().chars().all(|c| c.is_ascii_alphanumeric())
    })
}

/// Check a Dockerfile against the build rule (see the module docs).
pub fn check(text: &str) -> anyhow::Result<Checked> {
    let instructions = instructions(text)?;
    let mut stages: Vec<String> = Vec::new();
    let mut froms = 0_usize;
    let mut images: Vec<String> = Vec::new();
    if !instructions
        .first()
        .is_some_and(|i| i.keyword == "FROM" || i.keyword == "ARG")
    {
        bail!("a Dockerfile starts with FROM");
    }
    for instruction in &instructions {
        let keyword = instruction.keyword.as_str();
        if !ALLOWED.contains(&keyword) {
            bail!(
                "`{keyword}` is not supported: Noite builds only Dockerfiles that run nothing \
                 ({}); publish an image that needs `{keyword}` to a registry and name it instead",
                ALLOWED.join(", ")
            );
        }
        if instruction.args.contains("<<") {
            bail!("`{keyword}` uses a heredoc, which is not supported");
        }
        match keyword {
            "FROM" => {
                let tokens: Vec<&str> = instruction.args.split_whitespace().collect();
                let (image, alias) = match tokens.as_slice() {
                    [image] => (*image, None),
                    [image, kw, alias] if kw.eq_ignore_ascii_case("as") => (*image, Some(*alias)),
                    _ => bail!(
                        "`FROM {}` is not `FROM <image> [AS <name>]`",
                        instruction.args
                    ),
                };
                if image.starts_with("--") {
                    bail!("`FROM` flags are not supported (the platform is the install's)");
                }
                check_reference(image, "FROM")?;
                let lowered = image.to_ascii_lowercase();
                if lowered != "scratch" && !stages.contains(&lowered) {
                    add_image(image, &mut images);
                }
                if let Some(alias) = alias {
                    stages.push(alias.to_ascii_lowercase());
                }
                froms += 1;
            }
            "COPY" => {
                for flag in instruction
                    .args
                    .split_whitespace()
                    .take_while(|t| t.starts_with("--"))
                {
                    let (name, value) = flag.split_once('=').unwrap_or((flag, ""));
                    if !COPY_FLAGS.contains(&name) {
                        bail!("`COPY {flag}` is not supported");
                    }
                    if name == "--from" {
                        let lowered = value.to_ascii_lowercase();
                        if value.is_empty() {
                            bail!("`COPY --from` names nothing");
                        }
                        // A number is always a stage index to Docker.
                        if let Ok(stage) = value.parse::<usize>() {
                            if stage + 1 >= froms {
                                bail!("`COPY --from={stage}` names no earlier stage");
                            }
                            continue;
                        }
                        if !stages.contains(&lowered) {
                            check_reference(value, "COPY --from")?;
                            add_image(value, &mut images);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(Checked {
        instructions,
        images,
    })
}

fn add_image(image: &str, images: &mut Vec<String>) {
    if !images.iter().any(|seen| seen == image) {
        images.push(image.to_string());
    }
}

/// A registry reference as Docker spells one, with nothing a build argument
/// could swap at build time.
fn check_reference(image: &str, what: &str) -> anyhow::Result<()> {
    let valid = !image.is_empty()
        && !image.starts_with('-')
        && image
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '/' | ':' | '@'));
    if !valid {
        bail!("`{what} {image}` is not a plain image reference (no build arguments)");
    }
    Ok(())
}

impl Checked {
    /// The Dockerfile Noite builds: every registry image replaced by its
    /// pinned reference, so the build reads exactly what was checked.
    fn render(&self, pinned: &[(String, String)]) -> String {
        let pin = |image: &str| {
            pinned
                .iter()
                .find(|(name, _)| name == image)
                .map_or_else(|| image.to_string(), |(_, digest)| digest.clone())
        };
        let mut out =
            String::from("# Written by Noite from the app's Dockerfile: registry images pinned.\n");
        for instruction in &self.instructions {
            let args = match instruction.keyword.as_str() {
                "FROM" => {
                    let mut tokens = instruction.args.split_whitespace();
                    let image = tokens.next().unwrap_or_default();
                    let rest: Vec<&str> = tokens.collect();
                    std::iter::once(pin(image))
                        .chain(rest.iter().map(|t| (*t).to_string()))
                        .collect::<Vec<_>>()
                        .join(" ")
                }
                "COPY" => instruction
                    .args
                    .split_whitespace()
                    .map(|token| match token.strip_prefix("--from=") {
                        Some(image) => format!("--from={}", pin(image)),
                        None => token.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => instruction.args.clone(),
            };
            out.push_str(&instruction.keyword);
            if !args.is_empty() {
                out.push(' ');
                out.push_str(&args);
            }
            out.push('\n');
        }
        out
    }
}

/// What a Dockerfile entry asks for, resolved against the worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub dockerfile: PathBuf,
    pub context: Option<PathBuf>,
}

/// Check `request`, pull and vet its registry images, and write the pinned
/// Dockerfile into its build context. Returns the written Dockerfile's
/// absolute path (`celld deploy` builds it with its directory as context).
///
/// Both paths must resolve (symlinks included) inside `src`: the build
/// reads the context as root, so a context outside the worktree would copy
/// platform files into a tenant image.
pub async fn prepare(
    src: &Path,
    index: usize,
    request: &Request,
    platform: &str,
) -> anyhow::Result<PathBuf> {
    let dockerfile = within(src, &request.dockerfile)
        .with_context(|| format!("Dockerfile {}", request.dockerfile.display()))?;
    let context = match &request.context {
        Some(context) => {
            within(src, context).with_context(|| format!("build context {}", context.display()))?
        }
        None => dockerfile
            .parent()
            .map(Path::to_path_buf)
            .context("the Dockerfile has no directory")?,
    };
    if !context.is_dir() {
        bail!("build context {} is not a directory", context.display());
    }
    check_context(&context)?;
    let meta = std::fs::metadata(&dockerfile)?;
    if !meta.is_file() {
        bail!("Dockerfile {} is not a regular file", dockerfile.display());
    }
    let size = meta.len();
    if size > MAX_DOCKERFILE_BYTES {
        bail!(
            "Dockerfile {} is larger than {MAX_DOCKERFILE_BYTES} bytes",
            dockerfile.display()
        );
    }
    let text = std::fs::read_to_string(&dockerfile)
        .with_context(|| format!("read {}", dockerfile.display()))?;
    let checked = check(&text).with_context(|| format!("Dockerfile {}", dockerfile.display()))?;
    if checked.images.len() > MAX_IMAGES {
        bail!(
            "Dockerfile {} reads {} registry images; at most {MAX_IMAGES} may",
            dockerfile.display(),
            checked.images.len()
        );
    }
    let mut pinned = Vec::new();
    for image in &checked.images {
        pinned.push((image.clone(), vet(image, platform).await?));
    }
    let target = context.join(format!(".noite-image-{index}.Dockerfile"));
    crate::host::build_output::write_fresh(&target, &checked.render(&pinned))?;
    Ok(target)
}

/// Bound the build context and keep every symlink in it pointing inside
/// it, whatever the builder does with links (BuildKit confines them; the
/// legacy builder is not relied on).
fn check_context(context: &Path) -> anyhow::Result<()> {
    let mut bytes = 0_u64;
    let mut files = 0_usize;
    let mut pending = vec![context.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).with_context(|| format!("read {}", dir.display()))? {
            let entry = entry?;
            let path = entry.path();
            let meta = entry.metadata()?;
            files += 1;
            if files > MAX_CONTEXT_FILES {
                bail!(
                    "build context {} holds more than {MAX_CONTEXT_FILES} entries",
                    context.display()
                );
            }
            if meta.is_symlink() {
                let resolved = path.canonicalize().ok();
                if !resolved.is_some_and(|target| target.starts_with(context)) {
                    bail!(
                        "{} links outside the build context {}",
                        path.display(),
                        context.display()
                    );
                }
            } else if meta.is_dir() {
                pending.push(path);
            } else {
                bytes += meta.len();
                if bytes > MAX_CONTEXT_BYTES {
                    bail!(
                        "build context {} is larger than {} MiB",
                        context.display(),
                        MAX_CONTEXT_BYTES / 1024 / 1024
                    );
                }
            }
        }
    }
    Ok(())
}

/// `path` resolved, symlinks included, and required inside `src`.
fn within(src: &Path, path: &Path) -> anyhow::Result<PathBuf> {
    let resolved = path.canonicalize().context("not found")?;
    if !resolved.starts_with(src) {
        bail!("is outside the app's worktree");
    }
    Ok(resolved)
}

/// Pull `image` for the nodes' platform, refuse it when it carries `ONBUILD`
/// triggers (a `FROM` would run them during the build), and return it
/// pinned by digest. An image that only exists on this engine (another
/// app's `celld-image:` tag, say) does not pull, and is refused.
async fn vet(image: &str, platform: &str) -> anyhow::Result<String> {
    let pulled = docker(
        &["pull", "--quiet", "--platform", platform, image],
        Duration::from_secs(600),
    )
    .await
    .with_context(|| format!("pull {image}"))?;
    if !pulled.status.success() {
        bail!(
            "pull {image}: {}",
            String::from_utf8_lossy(&pulled.stderr).trim()
        );
    }
    let inspected = docker(
        &[
            "image",
            "inspect",
            "--format",
            "{{json .Config.OnBuild}}\t{{json .RepoDigests}}",
            image,
        ],
        Duration::from_secs(30),
    )
    .await
    .with_context(|| format!("inspect {image}"))?;
    if !inspected.status.success() {
        bail!(
            "inspect {image}: {}",
            String::from_utf8_lossy(&inspected.stderr).trim()
        );
    }
    pinned_reference(image, &String::from_utf8_lossy(&inspected.stdout))
}

/// Read `{{json .Config.OnBuild}}\t{{json .RepoDigests}}`: no triggers, and
/// the first registry digest.
fn pinned_reference(image: &str, inspect: &str) -> anyhow::Result<String> {
    let (onbuild, digests) = inspect
        .trim()
        .split_once('\t')
        .with_context(|| format!("inspect {image}: unexpected output"))?;
    let triggers: Option<Vec<String>> =
        serde_json::from_str(onbuild).with_context(|| format!("inspect {image}: OnBuild"))?;
    if triggers.is_some_and(|t| !t.is_empty()) {
        bail!("{image} carries ONBUILD triggers, which would run during the build");
    }
    let digests: Option<Vec<String>> =
        serde_json::from_str(digests).with_context(|| format!("inspect {image}: RepoDigests"))?;
    digests
        .unwrap_or_default()
        .into_iter()
        .find(|digest| digest.contains("@sha256:"))
        .with_context(|| format!("{image} has no registry digest"))
}

async fn docker(args: &[&str], timeout: Duration) -> anyhow::Result<std::process::Output> {
    let child = tokio::process::Command::new("docker")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .context("run docker")?;
    tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .context("timed out")?
        .context("wait for docker")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Void's default Sandbox image (`void/sandbox.Dockerfile`, void 1.5).
    const VOID_DEFAULT: &str = "FROM node:26.12.1-trixie-slim\nCOPY --from=docker.io/cloudflare/sandbox:1.0.3 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim\nWORKDIR /workspace\nCMD [\"sleep\", \"infinity\"]\n";

    #[test]
    fn voids_default_image_builds_and_pins_both_images() {
        let checked = check(VOID_DEFAULT).expect("Void's default runs nothing");
        assert_eq!(
            checked.images,
            vec![
                "node:26.12.1-trixie-slim",
                "docker.io/cloudflare/sandbox:1.0.3"
            ]
        );
        let rendered = checked.render(&[
            ("node:26.12.1-trixie-slim".into(), "node@sha256:aaa".into()),
            (
                "docker.io/cloudflare/sandbox:1.0.3".into(),
                "cloudflare/sandbox@sha256:bbb".into(),
            ),
        ]);
        assert!(rendered.contains("\nFROM node@sha256:aaa\n"), "{rendered}");
        assert!(
            rendered.contains("\nCOPY --from=cloudflare/sandbox@sha256:bbb /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim\n"),
            "{rendered}"
        );
        assert!(
            rendered.contains("\nCMD [\"sleep\", \"infinity\"]\n"),
            "{rendered}"
        );
    }

    /// Pinning tokenizes like the check: a tab after `--from=<image>` must
    /// not leave the image unpinned (the build would pull a retagged one).
    #[test]
    fn copy_from_is_pinned_whatever_the_whitespace() {
        let checked = check("FROM scratch\nCOPY --from=evil:1\t/a\t/b\n").expect("copy");
        assert_eq!(checked.images, vec!["evil:1"]);
        let rendered = checked.render(&[("evil:1".into(), "evil@sha256:ccc".into())]);
        assert!(
            rendered.contains("COPY --from=evil@sha256:ccc /a /b\n"),
            "{rendered}"
        );
        assert!(!rendered.contains("evil:1"), "{rendered}");
    }

    #[test]
    fn image_references_that_read_as_flags_are_refused() {
        assert!(check("FROM -f\n").is_err());
        assert!(check("FROM scratch\nCOPY --from=-x /a /b\n").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn context_links_must_stay_inside_and_size_is_bounded() {
        let base = std::env::temp_dir().join(format!("noite-ctx-{}", uuid::Uuid::new_v4()));
        let ctx = base.join("ctx");
        std::fs::create_dir_all(ctx.join("sub")).unwrap();
        std::fs::write(ctx.join("sub/a"), "a").unwrap();
        std::os::unix::fs::symlink(ctx.join("sub/a"), ctx.join("inside")).unwrap();
        let ctx = ctx.canonicalize().unwrap();
        check_context(&ctx).expect("links inside the context are fine");
        std::os::unix::fs::symlink("/etc/passwd", ctx.join("sub/out")).unwrap();
        assert!(format!("{:#}", check_context(&ctx).unwrap_err()).contains("links outside"));
        std::fs::remove_file(ctx.join("sub/out")).unwrap();
        let big = std::fs::File::create(ctx.join("big")).unwrap();
        big.set_len(MAX_CONTEXT_BYTES + 1).unwrap();
        assert!(format!("{:#}", check_context(&ctx).unwrap_err()).contains("larger than"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn stages_are_not_registry_images() {
        let checked = check(
            "FROM node:26 AS base\nCOPY app /app\nFROM base\nCOPY --from=base /app /app\nCOPY --from=0 /app /x\nFROM scratch\n",
        )
        .expect("stages");
        assert_eq!(checked.images, vec!["node:26"]);
    }

    #[test]
    fn continuations_and_comments_join_like_docker() {
        let checked =
            check("FROM node:26\n# a comment\nENV A=1 \\\n  # skipped\n  B=2\n").expect("joined");
        assert_eq!(checked.instructions.len(), 2);
        assert_eq!(checked.instructions[1].args, "A=1  B=2");
    }

    #[test]
    fn anything_that_runs_or_swaps_the_builder_is_refused() {
        for (name, text) in [
            ("RUN", "FROM node:26\nRUN echo pwned\n"),
            ("lowercase run", "FROM node:26\nrun echo pwned\n"),
            ("ADD", "FROM node:26\nADD https://example.com/x /x\n"),
            ("ONBUILD", "FROM node:26\nONBUILD RUN echo\n"),
            ("SHELL", "FROM node:26\nSHELL [\"/bin/sh\"]\n"),
            ("HEALTHCHECK", "FROM node:26\nHEALTHCHECK CMD true\n"),
            ("VOLUME", "FROM node:26\nVOLUME /data\n"),
            ("syntax directive", "# syntax=evil/frontend\nFROM node:26\n"),
            ("escape directive", "# escape=`\nFROM node:26\n"),
            ("heredoc", "FROM node:26\nCOPY <<EOF /x\nhi\nEOF\n"),
            ("build arg in FROM", "ARG BASE=node:26\nFROM ${BASE}\n"),
            (
                "build arg in COPY --from",
                "FROM node:26\nCOPY --from=$IMG /a /b\n",
            ),
            (
                "FROM platform flag",
                "FROM --platform=$BUILDPLATFORM node:26\n",
            ),
            (
                "unknown COPY flag",
                "FROM node:26\nCOPY --checksum=sha256:00 a b\n",
            ),
            ("no FROM", "COPY a b\n"),
            ("dangling continuation", "FROM node:26\nENV A=1 \\\n"),
        ] {
            assert!(check(text).is_err(), "{name} must be refused");
        }
    }

    #[test]
    fn onbuild_triggers_and_local_only_images_are_refused() {
        assert_eq!(
            pinned_reference("node:26", "null\t[\"node@sha256:abc\"]\n").unwrap(),
            "node@sha256:abc"
        );
        assert_eq!(
            pinned_reference("node:26", "[]\t[\"node@sha256:abc\"]").unwrap(),
            "node@sha256:abc"
        );
        let triggered = pinned_reference("evil:1", "[\"RUN curl x | sh\"]\t[\"evil@sha256:abc\"]");
        assert!(format!("{:#}", triggered.unwrap_err()).contains("ONBUILD"));
        // An image built on this engine has no registry digest.
        assert!(pinned_reference("celld-image:abc", "null\t[]").is_err());
        assert!(pinned_reference("celld-image:abc", "null\tnull").is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn paths_outside_the_worktree_are_refused_before_any_pull() {
        let base = std::env::temp_dir().join(format!("noite-image-{}", uuid::Uuid::new_v4()));
        let src = base.join("src");
        std::fs::create_dir_all(src.join("sandbox")).unwrap();
        std::fs::write(base.join("Dockerfile"), "FROM scratch\n").unwrap();
        std::os::unix::fs::symlink(base.join("Dockerfile"), src.join("sandbox/Dockerfile"))
            .unwrap();
        let src = src.canonicalize().unwrap();
        // A symlink out of the worktree, and a context outside it.
        let escape = Request {
            dockerfile: src.join("sandbox/Dockerfile"),
            context: None,
        };
        assert!(format!(
            "{:#}",
            prepare(&src, 0, &escape, "linux/amd64").await.unwrap_err()
        )
        .contains("outside the app's worktree"));
        std::fs::write(src.join("sandbox/Real"), "FROM scratch\n").unwrap();
        let outside = Request {
            dockerfile: src.join("sandbox/Real"),
            context: Some(base.clone()),
        };
        assert!(format!(
            "{:#}",
            prepare(&src, 0, &outside, "linux/amd64").await.unwrap_err()
        )
        .contains("outside the app's worktree"));
        // A context with a link out of it is refused.
        let linked = Request {
            dockerfile: src.join("sandbox/Real"),
            context: None,
        };
        assert!(format!(
            "{:#}",
            prepare(&src, 0, &linked, "linux/amd64").await.unwrap_err()
        )
        .contains("links outside the build context"));
        // A planted symlink at the output name is replaced, never followed.
        std::fs::create_dir_all(src.join("ok")).unwrap();
        std::fs::write(src.join("ok/Dockerfile"), "FROM scratch\n").unwrap();
        let victim = src.join("ok/victim");
        std::fs::write(&victim, "keep").unwrap();
        std::os::unix::fs::symlink(&victim, src.join("ok/.noite-image-0.Dockerfile")).unwrap();
        let ok = Request {
            dockerfile: src.join("ok/Dockerfile"),
            context: None,
        };
        let written = prepare(&src, 0, &ok, "linux/amd64")
            .await
            .expect("scratch needs no pull");
        assert_eq!(std::fs::read_to_string(&victim).unwrap(), "keep");
        assert!(std::fs::read_to_string(&written)
            .unwrap()
            .contains("FROM scratch"));
        let _ = std::fs::remove_dir_all(&base);
    }
}
