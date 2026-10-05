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

`createRepository()` escolhe a implementação de `DeviceRepository`, em ordem:

1. **SupabaseRepository**: quando `VITE_SUPABASE_URL` e
   `VITE_SUPABASE_PUBLISHABLE_KEY` estão definidos (veja `.env`). Lista em tempo
   real via Supabase Realtime.
2. **ClaudeDbRepository**: quando publicado como artifact do claude.ai.
3. **LocalStorageRepository**: grava só no navegador.

### Banco (Supabase)

Tabela `public.devices`, criada pelas migrations em `supabase/migrations/`:

| Coluna         | Tipo            | Observação                                        |
| -------------- | --------------- | ------------------------------------------------- |
| `id`           | uuid            | Gerado no cliente (`crypto.randomUUID()`)         |
| `model`        | text            | até 100 caracteres                                |
| `serial`       | text            | IMEI / nº de série; índice em `lower(btrim())`    |
| `technician`   | text            |                                                   |
| `results`      | jsonb           | `{ "<item_id>": "ok" \| "fail" \| "" }`, validado |
| `status`       | `device_status` | `incompleto`, `liberado` ou `reprovado`           |
| `tested_count` | smallint        |                                                   |
| `failed_items` | text[]          | títulos dos itens reprovados                      |
| `created_at`   | timestamptz     | imutável (trigger)                                |
| `updated_at`   | timestamptz     | definido pelo servidor a cada alteração           |

O catálogo de testes fica no código (`src/domain/checklist.ts`); o banco
guarda só o resultado por id de item.

O acesso é **público, sem login**: as políticas RLS permitem ler, criar e
editar, e não há permissão para apagar. Quem tiver o link do app pode ler e
alterar os registros.

Depois de mudar o schema, regenere `src/services/supabase/database.types.ts`.
