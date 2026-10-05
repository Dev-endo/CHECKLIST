# Checklist de testes · iPhone

Checklist funcional para aparelhos abertos, em React + TypeScript (Vite).

## Rodando

Requer Node.js 20.19+ ou 22.12+.

```sh
npm install
npm run dev        # servidor de desenvolvimento
npm test           # testes do domínio (Vitest)
npm run build      # checagem de tipos + build de produção em dist/
```

## Estrutura

```
src/
  domain/      Regras puras, sem React: itens do checklist, status, laudo
  services/    Persistência (DeviceRepository) e preferências do navegador
  hooks/       Estado do rascunho, autosave, assinatura dos registros
  components/  UI, um diretório por componente, com CSS Module
  styles/      Tokens de cor (claro/escuro) e estilos base
```

Para adicionar ou alterar testes, edite só `src/domain/checklist.ts`.

## Persistência

`createRepository()` escolhe a implementação de `DeviceRepository`:

- **ClaudeDbRepository**: quando publicado como artifact do claude.ai, usa o
  banco compartilhado (`window.claude.use("db")`, coleção `aparelhos`).
- **LocalStorageRepository**: fora desse ambiente, grava só no navegador.

O formato do documento (`modelo`, `serial`, `tec`, `r`, `status`, `falhas`,
`testados`, `criado`, `atualizado`) é o mesmo da versão em HTML, então os
registros existentes continuam abrindo.
