# LouvorKey Studio

Site responsivo para repertório de louvor com player web, upload de músicas, mudança de tom, metrônomo virtual e separação de faixas por IA.

## Rodar localmente

1. Instale as dependências:
   `npm install`
2. Configure as variáveis em `.env`.
3. Rode o frontend:
   `npm run web`
4. Rode o backend em outro terminal:
   `npm run backend:dev`

## Build e produção

- `npm run build:web` gera o site em `dist/`.
- `npm run backend` gera o build web e sobe o servidor Express.
- Em produção, o mesmo servidor entrega o site e as rotas `/api/*`.

## Importar do YouTube

- Cole o link na aba YouTube e salve normalmente.
- Se o YouTube bloquear o servidor com verificação anti-robô, anexe um `cookies.txt` exportado do domínio `youtube.com` no próprio modal. O site guarda esse arquivo apenas no navegador e o backend apaga o arquivo temporário depois do download.
- Também é possível configurar `YTDLP_COOKIES_BASE64` no servidor para usar cookies fixos em produção.
