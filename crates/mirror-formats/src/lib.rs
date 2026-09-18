//! Encoders and decoders for LoaF, PNGSpeak, GIF89a, and GPTGIF formats.

#![allow(
    clippy::needless_range_loop,
    clippy::too_many_arguments,
    clippy::collapsible_if,
    clippy::manual_div_ceil,
    clippy::unnecessary_unwrap,
    clippy::useless_vec
)]

pub mod gif89a;
pub mod gptgif;
pub mod gptgif_v4;
pub mod loaf;
pub mod pngspeak;

pub use gif89a::{GifColor, GifError, GifFrame, GifImage, read_gif, write_gif};
pub use gptgif::{
    ClusterResult, FONT, GlyphMask, calibrate_gptgif, cluster_glyph_tiles, decode_gptgif,
    encode_gptgif, gunzip_gptgif_output,
};
pub use gptgif_v4::{
    EncodeGptgifV4Options, GlyphFont, GptgifV4Error, decode_gptgif_v4, default_palette,
    encode_gptgif_v4, font_from_bytes, font_to_bytes, palette_from_bytes, palette_to_bytes,
    random_font, random_palette, validate_font, validate_palette,
};
pub use loaf::{LoafEntry, LoafError, LoafExtractedEntry, pack_loaf, unpack_loaf};
pub use pngspeak::{
    PngSpeakDecodeOptions, PngSpeakEncodeOptions, PngSpeakError, decode_png_speak,
    encode_png_speak, python_round,
};
