package api

import (
	"net/http"

	"example.com/scout/internal/store"
	"github.com/gin-gonic/gin"
	chi "github.com/go-chi/chi/v5"
)

func Register(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/runs", startRun)
	mux.HandleFunc("/healthz", health)
}

func Chi(r chi.Router) {
	r.Get("/api/runs/{id}", getRun)
}

func Gin(r *gin.Engine) {
	r.GET("/api/usage/:month", usage)
}

func startRun(w http.ResponseWriter, r *http.Request) {
	store.SaveRun("acme")
	helper()
}

func getRun(w http.ResponseWriter, r *http.Request) { store.LoadRun("1") }

func health(w http.ResponseWriter, r *http.Request) {}

func usage(c *gin.Context) {}
