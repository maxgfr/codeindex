package main

import (
	"example.com/api/internal"
	"example.com/shared/util"
)

func main() {
	internal.Serve(util.Now())
}
