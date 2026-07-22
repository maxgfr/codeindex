// Command main wires the sub package together.
package main

import (
	"fmt"

	"example.com/mini/gopkg/sub"
)

func main() {
	fmt.Println(sub.DoThing())
}
