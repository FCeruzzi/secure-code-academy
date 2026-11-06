-- Secondi prima della prima domanda all'avvio della gara e di ogni round (da 3 a 60).
ALTER TABLE tournaments ADD COLUMN start_delay_seconds INTEGER NOT NULL DEFAULT 5;
