-- La soluzione di una domanda del torneo resta visibile almeno 10 secondi.
UPDATE tournaments SET reveal_seconds = 10 WHERE reveal_seconds < 10;
