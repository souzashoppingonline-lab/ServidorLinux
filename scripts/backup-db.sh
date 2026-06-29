#!/bin/bash
# Backup do banco de dados SQLite do ML Dashboard
# Uso: ./backup-db.sh [destino]
# Cron sugerido: 0 3 * * * /opt/ServidorLinux/scripts/backup-db.sh

set -euo pipefail

DB_PATH="${DB_PATH:-/var/lib/ml-dashboard/ml.db}"
BACKUP_DIR="${1:-/var/backups/ml-dashboard}"
DATE=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/ml_db_$DATE.db"
KEEP_DAYS="${KEEP_DAYS:-7}"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_PATH" ]; then
  echo "ERRO: Banco de dados não encontrado em $DB_PATH"
  exit 1
fi

# Backup usando SQLite online backup (seguro com DB aberto)
sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"

# Comprime para economizar espaço
gzip "$BACKUP_FILE"

echo "Backup criado: ${BACKUP_FILE}.gz ($(du -sh "${BACKUP_FILE}.gz" | cut -f1))"

# Remove backups antigos
find "$BACKUP_DIR" -name "ml_db_*.db.gz" -mtime +$KEEP_DAYS -delete
echo "Backups mais antigos que $KEEP_DAYS dias removidos."

# Lista backups existentes
echo "Backups disponíveis:"
ls -lh "$BACKUP_DIR"/ml_db_*.db.gz 2>/dev/null || echo "Nenhum backup encontrado."
