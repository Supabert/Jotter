use crate::error::{Error, Result};
use crate::models::SavedImage;
use crate::AppState;
use sha2::{Digest, Sha256};
use std::io::Write;
use tauri::State;

/// The extension is decided here from the bytes' own magic number, never from
/// anything the clipboard or a pasted `<img>` claimed. A file the store cannot
/// identify is refused rather than written under a guessed name.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, ..] => Some("png"),
        [0xFF, 0xD8, 0xFF, ..] => Some("jpg"),
        [b'G', b'I', b'F', b'8', ..] => Some("gif"),
        [b'B', b'M', ..] => Some("bmp"),
        _ if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" => {
            Some("webp")
        }
        _ => None,
    }
}

/// Content-addressed: the file name is the SHA-256 of its bytes, so pasting the
/// same screenshot into ten notes stores it once and nothing ever has to track
/// references. Combined with never-delete, an image can never be orphaned by a
/// note that still points at it.
#[tauri::command]
pub fn save_image(state: State<AppState>, bytes: Vec<u8>) -> Result<SavedImage> {
    const MAX_BYTES: usize = 64 * 1024 * 1024;
    if bytes.is_empty() {
        return Err(Error::Msg("empty image".into()));
    }
    if bytes.len() > MAX_BYTES {
        return Err(Error::Msg(format!(
            "image is {} MB; the limit is 64 MB",
            bytes.len() / 1_048_576
        )));
    }

    let ext = sniff(&bytes).ok_or_else(|| Error::Msg("unrecognized image format".into()))?;

    let hash = {
        let mut h = Sha256::new();
        h.update(&bytes);
        format!("{:x}", h.finalize())
    };

    let file_name = format!("{hash}.{ext}");
    let path = state.images_dir.join(&file_name);

    if !path.exists() {
        // Write to a temp sibling first so a crash mid-write can never leave a
        // truncated file sitting at a hash that claims to be complete.
        let tmp = state.images_dir.join(format!("{hash}.part"));
        {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
        }
        std::fs::rename(&tmp, &path)?;
    }

    let conn = state.conn.lock().unwrap();
    conn.execute(
        "INSERT OR IGNORE INTO images (hash, ext, bytes, created_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![hash, ext, bytes.len() as i64, chrono::Utc::now().to_rfc3339()],
    )?;

    Ok(SavedImage {
        hash,
        file: file_name,
        src: path.to_string_lossy().into_owned(),
    })
}

/// Resolve a stored image's absolute path for the frontend to hand to
/// `convertFileSrc`. Note HTML carries only the file name, so a note stays
/// portable and no absolute path is ever baked into saved content.
#[tauri::command]
pub fn image_path(state: State<AppState>, file: String) -> Result<String> {
    // Defend the store against a traversal smuggled in through pasted markup:
    // a valid entry is exactly `<64 hex chars>.<ext>` and nothing else.
    let (stem, ext) = file
        .rsplit_once('.')
        .ok_or_else(|| Error::Msg("bad image reference".into()))?;
    let valid = stem.len() == 64
        && stem.bytes().all(|b| b.is_ascii_hexdigit())
        && matches!(ext, "png" | "jpg" | "gif" | "bmp" | "webp");
    if !valid {
        return Err(Error::Msg("bad image reference".into()));
    }
    Ok(state.images_dir.join(file).to_string_lossy().into_owned())
}
