package store

import "database/sql"

var db *sql.DB

type Store struct{}

type Loader interface {
	Load(id string) error
}

func (s *Store) Close() error { return nil }

func SaveRun(company string) {
	db.Exec("INSERT INTO runs (company) VALUES ($1)", company)
}

func LoadRun(id string) {
	db.Query("SELECT * FROM runs WHERE id = $1", id)
}
