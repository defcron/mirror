// Guides describe the actual encoders used here, not a guessed upstream format.
// No generated payload, decoder implementation, or answer key is included.
export const decoderGuides = {
  loaf: `LoaF is one ASCII line: SHA256(-)=<64 lowercase hex hash> <hex data>.
Verify SHA-256 of the ASCII hex data against the header (hash the hex text, not decoded bytes).
Hex-decode the data, gzip-decompress it, then read the resulting USTAR archive in memory.
Recover the exact content bytes of payload.bin. Do not return the archive bytes or extract paths onto the filesystem.`,
  pngspeak: `PngSpeak stores bytes as RGBA pixels, row-major, four bytes per pixel (R,G,B,A).
This challenge uses an 8-bit RGBA PNG, non-interlaced, without resizing or art mode.
The PNG iTXt keyword "license" has uncompressed text with two space-separated hex integers:
the first is the byte length of the second field's ASCII representation; the second is the original payload byte length.
Read PNG pixels as RGBA without compositing transparency, concatenate their bytes, and truncate to that original length.
Alternatively concatenate IDAT chunks, zlib-decompress them, and remove each scanline's first filter byte (all are filter 0 in these files).
Keep alpha bytes, zero bytes, and trailing whitespace exactly.`,
  gptgif: `Original gptgif stores a byte payload visually.
The decoder must infer the glyph alphabet from the rendered image.
No font data is provided.
Do not assume glyph ordering.`,
  "gptgif-v4": `gptgif v4 is a 640x480 GIF with an initial calibration frame followed by payload frames.
Use the original GIF bytes. Read every frame as RGB without resizing. All cells are 8x8 pixels.
Calibration addressing is row-major: cell c begins at (8*(c%80), 8*floor(c/80)).
Cells 0..255 are solid color swatches identifying palette roles. Foreground roles are 40..239;
role 0 is background, 1..15 noise, and 31 decoys. Classify by RGB learned from swatches, not brightness.
Cells 320..335 show canonical glyphs for nibbles 0..15 using role 40 on background.
Cells 400..495 encode a 48-byte header with canonical glyphs: low nibble first, then high nibble.
Header bytes 0..7 are ASCII GPTGIF4 followed by NUL; 8..15 are uint64 little-endian payload length;
16..47 are the SHA-256 digest of the recovered payload.

Each payload frame carries at most 2400 bytes (4800 nibbles). Its frame index f starts at 0 after calibration.
All PRNG math is unsigned 32-bit. xorshift32(x): x ^= x<<13; x ^= x>>>17; x ^= x<<5;
mask to 32 bits after every step; >>> means unsigned right shift.
initial = (0xc0ffee00 + f*0x9e3779b1 + 0xdefc0ffe) modulo 2^32.
Start permutation P=[0..4799], state=initial. For k from 4799 down to 1:
state=xorshift32(state); swap P[k] with P[state%(k+1)].
Independently start glyphState=initial XOR 0x12345678. For logical slot i from 0..4799,
advance glyphState=xorshift32(glyphState); that is this slot's seed s.
Logical slot i: col=floor(i/60), row=i%60; reverse row to 59-row for odd col;
p=P[col*60+row]. Physical payload coordinates are column-major: (8*floor(p/60),8*(p%60)).

For each candidate canonical glyph, first remove pixels where (x+y)%2==1 if ((s>>>6)&7)==0.
Rotate its remaining coordinates by r=s&3:
r=0: (x,y); r=1: (7-y,x); r=2: (7-x,7-y); r=3: (y,7-x).
Then add jitter jx=min(((s>>>2)&3)-1,1), jy=min(((s>>>4)&3)-1,1).
Match the transformed mask to observed pixels in foreground roles 40..239, ignoring noise and decoys.
This yields encoded nibble e. Undo the shift: n=(e-((f*7+13)&15))&15.
On odd f, swap each consecutive pair of recovered nibbles.
Reassemble bytes low nibble first: byte=(n[2*j] | (n[2*j+1]<<4)) XOR 0xa5.
Read only the number of slots dictated by header length; concatenate frames and verify SHA-256.
The calibration alphabet and palette may vary; learn them from frame zero.`,
} as const;
