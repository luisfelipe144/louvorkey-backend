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
