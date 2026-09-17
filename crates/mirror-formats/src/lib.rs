//! Encoders and decoders for LoaF, PNGSpeak, GIF89a, and GPTGIF formats.

pub mod gif89a;
pub mod gptgif;
pub mod gptgif_v4;
pub mod loaf;
pub mod pngspeak;

pub use gif89a::{read_gif, write_gif, GifColor, GifError, GifFrame, GifImage};
pub use gptgif::{
    calibrate_gptgif, cluster_glyph_tiles, decode_gptgif, encode_gptgif, gunzip_gptgif_output,
    ClusterResult, GlyphMask, FONT,
};
pub use gptgif_v4::{
    decode_gptgif_v4, default_palette, encode_gptgif_v4, font_from_bytes, font_to_bytes,
    palette_from_bytes, palette_to_bytes, random_font, random_palette, validate_font,
    validate_palette, EncodeGptgifV4Options, GlyphFont, GptgifV4Error,
};
pub use loaf::{LoafEntry, LoafError, LoafExtractedEntry, pack_loaf, unpack_loaf};
pub use pngspeak::{
    decode_png_speak, encode_png_speak, python_round, PngSpeakDecodeOptions, PngSpeakEncodeOptions,
    PngSpeakError,
};
