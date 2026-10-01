# Video Player Tester

Comparison bench for showing one YouTube link in many ways, without a `<video>` element and without `getUserMedia`.

Scan the QR code on the pairing panel. That opens a companion remote where you paste a YouTube link. The comparison grid on the original screen updates.

https://callewallerstedt.github.io/video-player-tester/

**Outside the player** cards try storyboard scrub (canvas), an `<img>` frame stream, and WebCodecs → canvas, with sound on an `<audio>` element. Stream metadata comes from public Piped instances.

The phone-to-screen message goes through a public [ntfy.sh](https://ntfy.sh) topic named after the session code. You can also paste the link directly on the bench.

QR codes are drawn with Kazuhiko Arase’s MIT-licensed [qrcode-generator](http://www.d-project.com/).
