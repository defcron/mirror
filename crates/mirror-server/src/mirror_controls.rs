//! Injection CSS and JavaScript for the Mirror controls widget in ChatGPT.
//! Port of `apps/server/src/mirror-controls.ts`.

pub const INJECTION_CSS: &str = include_str!("../assets/inject.css");
pub const INJECTION_JS: &str = include_str!("../assets/inject.js");

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn injection_assets_are_non_empty() {
        assert!(!INJECTION_CSS.is_empty());
        assert!(!INJECTION_JS.is_empty());
        assert!(INJECTION_CSS.contains("mirror-launcher"));
        assert!(INJECTION_JS.contains("mirror-launcher"));
    }
}
