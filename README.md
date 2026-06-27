# Linux Security Monitor (LSM)

Monitor profissional de segurança para servidores Ubuntu/Debian.

## Instalação Rápida

```bash
git clone https://github.com/souzashoppingonline-lab/ServidorLinux.git
cd ServidorLinux
sudo bash scripts/install.sh
```

## Recursos

- **Monitoramento em Tempo Real** — CPU, memória, disco, rede
- **Alertas Telegram** — Notificações instantâneas de eventos críticos
- **Dashboard Web** — Interface completa com WebSocket em tempo real
- **Banco de Dados SQLite** — Histórico completo de eventos e métricas
- **Score de Risco** — Pontuação dinâmica de 0 a 100
- **Múltiplos Módulos** — SSH, usuários, processos, rede, integridade, firewall, SSL, Docker

## Detecção de Ameaças

| Módulo | Detecções |
|--------|-----------|
| SSH | Login root, força bruta, sessões ativas |
| Usuários | Novo usuário, mudança de grupos, sudo crítico |
| Processos | Miners, backdoors, processos ocultos, SUID |
| Rede | Port scan, conexões suspeitas, ARP spoofing |
| Integridade | Alteração de arquivos críticos (/etc/passwd, sshd_config, etc.) |
| Firewall | Status UFW/iptables, regras ausentes |
| SSL | Certificados expirando |
| Docker | Containers privilegiados |
| Auditoria | Parâmetros kernel, permissões, usuários |

## Comandos CLI

```bash
lsm status          # Status geral e risk score
lsm logs            # Seguir logs em tempo real
lsm audit           # Auditoria rápida de segurança
lsm audit full      # Auditoria completa
lsm events          # Últimos 20 eventos
lsm integrity       # Verificar integridade de arquivos
lsm telegram test   # Testar alertas Telegram
lsm restart         # Reiniciar serviços
```

## Dashboard Web

Acesse: `http://<servidor>:8443`

- Usuário padrão: `admin`
- Senha: definida na instalação

## Configuração Telegram

```bash
lsm telegram configure
```

## Arquitetura

```
/opt/linux-security-monitor/
├── scripts/           # Módulos de monitoramento
│   ├── lib.sh         # Biblioteca comum
│   ├── monitor.sh     # Orquestrador principal
│   ├── ssh.sh         # Monitor SSH
│   ├── users.sh       # Monitor de usuários
│   ├── process.sh     # Monitor de processos
│   ├── network.sh     # Monitor de rede
│   ├── integrity.sh   # Monitor de integridade
│   ├── audit.sh       # Auditoria do sistema
│   ├── telegram.sh    # Alertas Telegram
│   ├── daemon.sh      # Gerenciador do daemon
│   └── install.sh     # Instalação
├── web/               # Dashboard Node.js
│   ├── src/server.js  # API + WebSocket
│   └── public/        # Frontend
└── config/            # Configurações

/var/lib/lsm/lsm.db   # Banco de dados SQLite
/var/log/lsm/          # Logs
```

## Serviços Systemd

```bash
systemctl status lsm-monitor    # Monitor principal
systemctl status lsm-scheduler  # Tarefas agendadas
systemctl status lsm-web        # Dashboard web
```

## Desinstalação

```bash
sudo bash /opt/linux-security-monitor/scripts/uninstall.sh
```

---

Inspirado em Wazuh e OSSEC, mas muito mais leve e focado em VPS.
