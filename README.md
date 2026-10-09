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
  domain/      Regras puras, sem React: itens do checklist, status, papéis
  auth/        Login Google (AuthProvider) e bloqueio de quem não entrou
  services/    Persistência (DeviceRepository), Supabase e preferências do navegador
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

### Login e papéis

Com o Supabase configurado, o app só abre para quem entra com a **conta Google**
(não há login por e-mail e senha). O papel de cada usuário fica em
`public.profiles.role` (enum `user_role`):

| Papel         | Checklist de manutenção | Checklist de montagem | Registros e análise (todos) | Atribui papéis |
| ------------- | :-: | :-: | :-: | :-: |
| `tecnico`     | sim | não | não | não |
| `montador`    | não | sim | não | não |
| `supervisor`  | não | não | sim, só leitura | não |
| `admin`       | sim | sim | sim | sim (aba Administração) |
| `colaborador` | não | não | não | não (aguardando função) |

Só entram e-mails `@allugator.com` (trigger `enforce_email_domain`). Todo novo login
entra como `colaborador` ("Sem função") e o admin define o papel na aba Administração.
O checklist de manutenção libera o aparelho **para montagem** (a única liberação) ou o envia **para vidro** (continua em manutenção); o de montagem
só aceita seriais liberados para montagem pelo último checklist de manutenção. Se a
montagem reprova, informa-se a peça e se o erro foi de montagem (conta para o montador)
ou de manutenção (conta para o técnico que liberou). Os dois checklists usam a tabela
`devices` (coluna `kind`); as análises ficam na aba Registros > Análise.

#### Configuração única no Supabase

1. **Authentication > Sign In / Providers**: ative **Google** (Client ID e Secret do
   Google Cloud Console, tipo "Web application"; em "Authorized redirect URIs" use
   a URL de callback que o Supabase mostra) e **desative Email** e **Anonymous
   sign-ins**. Só assim ninguém cria conta por outro caminho.
2. **Authentication > URL Configuration**: defina a Site URL e inclua em
   Redirect URLs o endereço do app (`http://localhost:5173` no desenvolvimento).

### Ciclo do checklist

- O aparelho é gravado sozinho assim que **modelo, serial e técnico** estão
  preenchidos, e fica **pendente**: o dono pode alterar até concluir.
- **Concluir** finaliza o checklist (definitivo, sem edição) e abre um novo em branco.
- Ao digitar um serial que já tem checklist pendente, o app mostra o status e
  oferece **Retomar** ou **Reiniciar checklist** (o salvamento do aparelho novo fica
  pausado até a escolha). Se o serial já está concluído, oferece só **Ver registro**.

### Banco (Supabase)

Tabelas criadas pelas migrations em `supabase/migrations/`:

- `profiles`: `id` (= `auth.users.id`), `name`, `email`, `role`, `created_at`.
  Criada por trigger no primeiro login.
- `role_presets`: e-mail → papel inicial. Sem policies (fora da API).
- `devices`: um checklist por aparelho, abaixo.

| Coluna         | Tipo            | Observação                                        |
| -------------- | --------------- | ------------------------------------------------- |
| `id`           | uuid            | Gerado no cliente (`crypto.randomUUID()`)         |
| `user_id`      | uuid            | Dono (`profiles.id`); imutável                    |
| `model`        | text            | até 100 caracteres; obrigatório                   |
| `serial`       | text            | IMEI / nº de série; obrigatório                   |
| `technician`   | text            | obrigatório                                       |
| `results`      | jsonb           | `{ "<item_id>": "ok" | "fail" | "" }`, validado |
| `status`       | `device_status` | `incompleto`, `liberado` ou `reprovado`           |
| `phase`        | `device_phase`  | `pendente` ou `concluido`                         |
| `tested_count` | smallint        |                                                   |
| `failed_items` | text[]          | títulos dos itens reprovados                      |
| `concluded_at` | timestamptz     | definido pelo servidor ao concluir                |
| `created_at`   | timestamptz     | imutável (trigger)                                |
| `updated_at`   | timestamptz     | definido pelo servidor a cada alteração           |

O catálogo de testes fica no código (`src/domain/checklist.ts`); o banco
guarda só o resultado por id de item.

As permissões são garantidas por **RLS**, não pela interface: o colaborador lê e
cria só os próprios registros; supervisor e admin leem todos; só o dono altera, e
só enquanto `pendente`; ninguém apaga. Só o admin altera `profiles.role`, e não o
próprio. O acesso anônimo foi removido.

Depois de mudar o schema, regenere `src/services/supabase/database.types.ts`.
