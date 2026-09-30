# Schema reel de la base Neon (releve le 13/09/2026)

Sert de reference au portage : les requetes doivent coller a ces noms et ces types.
Identifiants en `uuid` (`gen_random_uuid()`), montants en `bigint`, dates en `date`,
horodatages en `timestamptz`.

| Table | Colonnes |
|---|---|
| `members` | id, full_name, email, phone, title, role, password_hash, must_change_password, is_active, joined_on, created_at |
| `contributions` | id, member_id, period, kind, amount, paid_on, method, reference, note, batch_id, status, declared_by, reviewed_by, reviewed_at, review_note, created_at |
| `securities_transfers` | id, transfer_date, amount, direction, note, created_by, created_at |
| `portfolio_valuations` | id, valued_on, total_value, cash_part, note, created_by, created_at |
| `penalties` | id, member_id, kind, quantity, unit_amount, reason, incurred_on, status, settled_on, settlement_note, created_by, resolved_by, resolved_at, created_at, source_key, auto |
| `cash_movements` | id, movement_date, direction, category, amount, note, status, created_by, reviewed_by, reviewed_at, review_note, created_at |
| `member_rules` | id, member_id, kind, numeric_value, starts_on, ends_on, is_active, note, created_by, created_at |
| `member_exits` | id, member_id, exit_date, reason, gross_value, fees, net_paid, forfeited, note, created_by, created_at |
| `meetings` | id, meeting_date, title, note, created_by, created_at |
| `attendances` | meeting_id, member_id, status, note |
| `payment_proofs` | id, batch_id, member_id, filename, mime, byte_size, data, uploaded_by, created_at, blob_url |
| `login_attempts` | id, email, ip, ok, attempted_at |
| `audit_log` | id, actor_id, actor_name, action, entity, entity_id, details, created_at |
| `reminder_log` | id, period, member_id, channel, ok, error, sent_at |
| `settings` | key, value, updated_at |

## Points d'attention

- `portfolio_valuations.total_value` est le **total**, `cash_part` en est la part liquide.
  La valeur des titres se deduit : `total_value - coalesce(cash_part, 0)`.
- `contributions.batch_id` regroupe les mois d'une meme avance : une ligne par mois
  couvert, toutes reliees par le meme lot.
- `penalties` : montant = `quantity * unit_amount`. `source_key` rend le calcul
  automatique idempotent, `auto` distingue le calcule du saisi.
- `securities_transfers` n'a pas de statut : la saisie vaut validation, avec
  `direction` pour distinguer apport et retrait.
- `reminder_log` porte une ligne par membre et par periode, pas une par mois.
- `attendances` n'a pas d'identifiant propre : la cle est le couple
  (`meeting_id`, `member_id`).

## Absent du schema

Aucune table ne trace la declaration de retard au groupe WhatsApp exigee par R3.
Elle est ajoutee par `scripts/migration-r3.sql`, en creation pure : aucune table
existante n'est modifiee ni supprimee.
