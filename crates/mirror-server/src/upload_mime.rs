//! Upload MIME type classification based on filename extension and multipart parsing.
//! Port of `apps/server/src/upload-mime.ts`.

use std::path::Path;

pub fn upload_mime_type(file_name: &str) -> &'static str {
    let trimmed = file_name.trim();
    let ext = Path::new(trimmed)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    match ext.to_ascii_lowercase().as_str() {
        "md" | "markdown" => "text/markdown",
        "txt" => "text/plain",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "json" => "application/json",
        "jsonl" => "application/x-ndjson",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "yaml" | "yml" => "application/yaml",
        "pdf" => "application/pdf",
        "rtf" => "application/rtf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "tif" | "tiff" => "image/tiff",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MultipartFile {
    pub file_name: String,
    pub data: Vec<u8>,
}

/// Parses a multipart/form-data payload and extracts the uploaded file.
pub fn parse_multipart_file(content_type: &str, body: &[u8]) -> Option<MultipartFile> {
    let boundary_marker = "boundary=";
    let boundary_idx = content_type.find(boundary_marker)?;
    let boundary = &content_type[boundary_idx + boundary_marker.len()..];
    let boundary = boundary.trim_matches('"').trim();

    let delimiter = format!("--{boundary}");
    let delim_bytes = delimiter.as_bytes();

    let mut pos = 0;
    while let Some(idx) = find_subsequence(&body[pos..], delim_bytes) {
        let part_start = pos + idx + delim_bytes.len();
        let part_start = if body.len() > part_start && body[part_start..].starts_with(b"\r\n") {
            part_start + 2
        } else if body.len() > part_start && body[part_start..].starts_with(b"\n") {
            part_start + 1
        } else {
            part_start
        };

        if part_start >= body.len() {
            break;
        }

        let next_delim = match find_subsequence(&body[part_start..], delim_bytes) {
            Some(d) => d,
            None => break,
        };
        let part_data = &body[part_start..part_start + next_delim];

        // Search for double newline separating headers from content
        if let Some(header_end) = find_subsequence(part_data, b"\r\n\r\n") {
            let header_bytes = &part_data[..header_end];
            let header_str = String::from_utf8_lossy(header_bytes);
            let mut content = &part_data[header_end + 4..];
            if content.ends_with(b"\r\n") {
                content = &content[..content.len() - 2];
            } else if content.ends_with(b"\n") {
                content = &content[..content.len() - 1];
            }

            if let Some(fn_idx) = header_str.find("filename=\"") {
                let after_fn = &header_str[fn_idx + 10..];
                if let Some(fn_end) = after_fn.find('"') {
                    let file_name = &after_fn[..fn_end];
                    return Some(MultipartFile {
                        file_name: file_name.to_string(),
                        data: content.to_vec(),
                    });
                }
            }
        }
        pos = part_start + next_delim;
    }
    None
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_common_extensions_to_mime_types() {
        assert_eq!(upload_mime_type("doc.md"), "text/markdown");
        assert_eq!(upload_mime_type("notes.markdown"), "text/markdown");
        assert_eq!(upload_mime_type("data.csv"), "text/csv");
        assert_eq!(upload_mime_type("photo.png"), "image/png");
        assert_eq!(upload_mime_type("photo.JPG"), "image/jpeg");
        assert_eq!(upload_mime_type("ARCHIVE.TAR"), "application/x-tar");
        assert_eq!(upload_mime_type("unknown.xyz"), "application/octet-stream");
        assert_eq!(upload_mime_type("noextension"), "application/octet-stream");
    }

    #[test]
    fn parses_multipart_form_data_file() {
        let boundary = "---------------------------974767299852498929531610575";
        let content_type = format!("multipart/form-data; boundary={boundary}");
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"hello.txt\"\r\nContent-Type: text/plain\r\n\r\nHello World\r\n--{boundary}--\r\n"
        );

        let parsed = parse_multipart_file(&content_type, body.as_bytes()).unwrap();
        assert_eq!(parsed.file_name, "hello.txt");
        assert_eq!(parsed.data, b"Hello World");
    }

    #[test]
    fn rejects_multipart_missing_filename() {
        let boundary = "boundary123";
        let content_type = format!("multipart/form-data; boundary={boundary}");
        let body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"field\"\r\n\r\nvalue\r\n--{boundary}--\r\n"
        );

        assert!(parse_multipart_file(&content_type, body.as_bytes()).is_none());
    }
}
