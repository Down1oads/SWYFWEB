# Caller photo templates

These are the user's Photoshop cartoon exports, with censor artwork preserved and only the separate Caller face layer hidden. The original Photoshop document was not changed.

Each PNG retains its 1024 x 1024 canvas. templates.json stores the visible Caller face layer bounds in Photoshop pixels: x/y from the top-left, then width/height. Unity converts the Y coordinate and accounts for transparent portrait margins when placing the caller's face.

- female-pic-1: (319.75, 119.5), 385.5 x 358.5 (1.5x the original head size, anchored at the original bottom center)
- female-pic-2: (384, 26), 257 x 239
- male-pic-1: (379, 67), 224 x 209
- male-pic-2: (13, 362), 257 x 239

The server chooses one matching template per call. Missing or unrecognized gender chooses among all four. The selected ID travels with the remote file entry, so every client uses the same picture. Files appear under Personal photos / Private photo.png and use the existing sensitive-file AI reaction in normal remote sessions.
