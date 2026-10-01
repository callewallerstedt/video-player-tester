# Video Player Tester

Fullscreen stage for one YouTube link. Prev / Next and the left and right arrow keys cycle techniques, one at a time, ordered by how likely they are to get past a page that blocks `<video>`.

Default video: `https://www.youtube.com/watch?v=RRxcfwAXVa8`

https://callewallerstedt.github.io/video-player-tester/

The first three techniques stay outside the YouTube player: WebCodecs onto a canvas, a storyboard scrub on canvas, and an image sprite, each with sound on an `<audio>` element at volume 100. The rest are embeds (IFrame Player API, iframe, object, embed, SVG) that unmute through the player API. Nothing on this page uses a `<video>` element or `getUserMedia`.

The phone pairing panel opens a companion remote. The link is sent through a public [ntfy.sh](https://ntfy.sh) topic named after the session code. You can also paste the link on the display.

QR codes are drawn with Kazuhiko Arase’s MIT-licensed [qrcode-generator](http://www.d-project.com/).
