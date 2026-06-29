# Dashboard CFO — Mercado Livre

Painel de gestão financeira para vendedores do Mercado Livre com múltiplas lojas.
Sincroniza pedidos automaticamente e exibe margens, custos e faturamento em tempo real.

## Recursos

- **Vendas Totais** — Tabela completa com faturamento, custo, tarifa, frete e margem por pedido
- **Cards de resumo** — Faturamento, custo, tarifa, frete e margem de contribuição do período
- **Multi-loja** — Gerencia várias contas do Mercado Livre no mesmo painel
- **Custo editável** — Cadastre o custo de cada produto direto no modal da venda
- **Sincronização automática** — Busca novos pedidos a cada 5 minutos
- **Tipo de envio** — Badge FULL / Flex / ME2 em cada venda
- **Skill /cfo** — Análise executiva com decisões de compra via Claude Code

## Requisitos

- Ubuntu 22.04+ ou Debian 12+
- Node.js 18+
- root ou sudo

## Instalação Rápida

```bash
# 1. Clonar o repositório
git clone https://github.com/souzashoppingonline-lab/ServidorLinux.git
cd ServidorLinux
git checkout claude/busy-cori-2nroj8

# 2. Criar arquivo de credenciais (não vai para o Git)
cat > /etc/ml-dashboard.env << 'EOF'
ML_APP_ID=SEU_APP_ID
ML_APP_SECRET=SEU_APP_SECRET
EOF
chmod 600 /etc/ml-dashboard.env

# 3. Instalar
cd mercadolivre-dashboard
sudo bash install.sh
```

O instalador faz automaticamente:
- Instala Node.js 20 se necessário
- Copia arquivos para `/opt/ml-dashboard`
- Instala dependências npm
- Cria e inicia o serviço systemd na porta **3001**

Acesse: `http://IP_DO_SERVIDOR:3001`

## Credenciais do App Mercado Livre

Obtenha em [developers.mercadolivre.com.br](https://developers.mercadolivre.com.br/):

1. Crie um aplicativo
2. Copie o **App ID** e o **Secret**
3. Configure o redirect URI: `https://seudominio.com/ml/callback`

## Configurar Nginx + HTTPS (opcional)

```bash
cp mercadolivre-dashboard/nginx.conf /etc/nginx/sites-available/ml-dashboard

# Edite o domínio no arquivo
nano /etc/nginx/sites-available/ml-dashboard

ln -s /etc/nginx/sites-available/ml-dashboard /etc/nginx/sites-enabled/
certbot --nginx -d seudominio.com
nginx -t && systemctl reload nginx
```

## Estrutura

```
mercadolivre-dashboard/
├── src/
│   └── server.js          # Servidor Node.js + API + sync ML
├── public/
│   ├── index.html         # Interface principal
│   ├── css/app.css        # Estilos
│   └── js/app.js          # Frontend
├── systemd/
│   └── ml-dashboard.service
├── nginx.conf
└── install.sh             # Instalador automático

/var/lib/ml-dashboard/ml.db   # Banco de dados SQLite
/etc/ml-dashboard.env          # Credenciais (não commitado)
```

## Serviço Systemd

```bash
systemctl status ml-dashboard      # Ver status
systemctl restart ml-dashboard     # Reiniciar
journalctl -u ml-dashboard -f      # Ver logs em tempo real
```

## Backup do Banco de Dados

```bash
# Backup manual
bash scripts/backup-db.sh

# Backup automático diário às 3h
echo "0 3 * * * root bash /opt/ServidorLinux/scripts/backup-db.sh" > /etc/cron.d/ml-dashboard-backup
```

Backups ficam em `/var/backups/ml-dashboard/` com retenção de 7 dias.

## Variáveis de Ambiente

| Variável | Descrição | Padrão |
|----------|-----------|--------|
| `ML_APP_ID` | ID do app Mercado Livre | **obrigatório** |
| `ML_APP_SECRET` | Secret do app Mercado Livre | **obrigatório** |
| `ML_REDIRECT_URI` | URL de callback OAuth | `https://multimixvendas.duckdns.org/ml/callback` |
| `PORT` | Porta do servidor | `3001` |
| `DATA_DIR` | Diretório do banco de dados | `/var/lib/ml-dashboard` |

## Instalação em Novo Servidor

O banco de dados **não é transferido** entre servidores. Ao instalar em um novo servidor:

1. Instale normalmente seguindo os passos acima
2. Acesse o painel e conecte cada loja via OAuth (botão "Adicionar Loja")
3. A sincronização de pedidos começa automaticamente (últimos 30 dias)

## Skill CFO (Claude Code)

Com o [Claude Code](https://claude.ai/code) instalado, rode dentro do projeto:

```
/cfo
```

Gera análise executiva com faturamento, margens, decisões de compra e alertas críticos.
