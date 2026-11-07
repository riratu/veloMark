//go:build ignore

// icons draws web/static/icon.svg as the PNGs an installed app needs, since
// Android wants pictures, not SVG: go run tools/icons.go
package main

import (
	"image"
	"image/color"
	"image/png"
	"log"
	"math"
	"os"
)

var blue = color.NRGBA{11, 88, 187, 255} // oklch(48% 0.17 258), as in the SVG

// draw renders the icon at size px. full fills the square with the blue, for
// Android's "maskable" icon that it cuts to its own shape; else the note
// stands on transparent ground as in the SVG.
func draw(size int, full bool) *image.NRGBA {
	const ss = 4 // samples per pixel side, for smooth edges
	img := image.NewNRGBA(image.Rect(0, 0, size, size))
	scale := float64(size) / 32
	inside := func(x, y float64) color.NRGBA {
		// The SVG's 32×32 space; the maskable one keeps the note in the safe middle.
		if full {
			x, y = (x-16)/0.75+16, (y-16)/0.75+16
		}
		for _, l := range [][3]float64{{10, 22, 11}, {10, 22, 16}, {10, 17, 21}} {
			dx := math.Max(l[0]-x, math.Max(0, x-l[1]))
			if math.Hypot(dx, y-l[2]) <= 1.2 {
				return color.NRGBA{255, 255, 255, 255}
			}
		}
		if full || roundRect(x, y, 5, 3, 22, 26, 4) {
			return blue
		}
		return color.NRGBA{}
	}
	for py := 0; py < size; py++ {
		for px := 0; px < size; px++ {
			var r, g, b, a float64
			for sy := 0; sy < ss; sy++ {
				for sx := 0; sx < ss; sx++ {
					c := inside((float64(px)+(float64(sx)+0.5)/ss)/scale, (float64(py)+(float64(sy)+0.5)/ss)/scale)
					w := float64(c.A) / 255
					r, g, b, a = r+float64(c.R)*w, g+float64(c.G)*w, b+float64(c.B)*w, a+w
				}
			}
			if a > 0 {
				img.SetNRGBA(px, py, color.NRGBA{uint8(r / a), uint8(g / a), uint8(b / a), uint8(255 * a / ss / ss)})
			}
		}
	}
	return img
}

func roundRect(x, y, rx, ry, w, h, rad float64) bool {
	if x < rx || y < ry || x > rx+w || y > ry+h {
		return false
	}
	cx := math.Max(rx+rad, math.Min(x, rx+w-rad))
	cy := math.Max(ry+rad, math.Min(y, ry+h-rad))
	return math.Hypot(x-cx, y-cy) <= rad
}

func main() {
	for _, f := range []struct {
		name string
		size int
		full bool
	}{
		{"web/static/icon-192.png", 192, false},
		{"web/static/icon-512.png", 512, false},
		{"web/static/icon-maskable-512.png", 512, true},
		{"web/static/apple-touch-icon.png", 180, true},
	} {
		out, err := os.Create(f.name)
		if err != nil {
			log.Fatal(err)
		}
		if err := png.Encode(out, draw(f.size, f.full)); err != nil {
			log.Fatal(err)
		}
		out.Close()
	}
}
