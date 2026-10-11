package main

import (
	"net/http"

	"example.com/scout/internal/api"
)

func main() {
	mux := http.NewServeMux()
	api.Register(mux)
	http.ListenAndServe(":8080", mux)
}
