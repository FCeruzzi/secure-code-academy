-- Domande scelte a mano dall'organizzatore del torneo: se ce ne sono, il torneo
-- pesca solo da queste invece che dalla banca dei corsi selezionati.
CREATE TABLE tournament_picks (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  PRIMARY KEY (tournament_id, question_id)
);
CREATE INDEX tournament_picks_question ON tournament_picks(question_id);
