import "server-only";
import { db } from "./db";
import { avecTables } from "./tables-auto";
import { listerApports, listerMembres, listerValorisations, netApport } from "./queries";
import { envoyerAlertes } from "./alertes";
import { peut } from "./droits";
import { nombre } from "./settings";
import {
  type Cours,
  type LigneReleve,
  type Mouvement,
  type NatureMouvement,
  type Releve,
  departDeLAnnee,
  lireDividendesBrvm,
  quantiteALaVeille,
  symboleDuDividende,
  lireCoursBrvm,
  lireIndiceComposite,
  liquiditesApres,
  dateDeSeance,
  performance,
  positionsApres,
  valoriser,
} from "./bourse";

/** Le meme texte que scripts/migration-bourse.sql. */
const TABLES = [
  `create table if not exists stock_quotes (
    trade_date date not null,
    symbol     text not null,
    name       text not null,
    close      numeric not null,
    change_pct numeric not null default 0,
    primary key (trade_date, symbol)
  )`,
  `create table if not exists index_quotes (
    trade_date date not null,
    code       text not null,
    close      numeric not null,
    day_pct    numeric not null,
    ytd_pct    numeric not null,
    primary key (trade_date, code)
  )`,
  `create table if not exists sgi_statements (
    id             uuid primary key default gen_random_uuid(),
    statement_date date not null unique,
    cash           numeric not null,
    total          numeric,
    imported_by    uuid references members(id) on delete set null,
    imported_at    timestamptz not null default now()
  )`,
  `create table if not exists sgi_statement_lines (
    statement_id uuid not null references sgi_statements(id) on delete cascade,
    symbol       text,
    sgi_name     text not null,
    quantity     numeric not null,
    avg_cost     numeric not null,
    price        numeric not null,
    value        numeric not null
  )`,
  `create table if not exists stock_movements (
    id         uuid primary key default gen_random_uuid(),
    trade_date date not null,
    kind       text not null check (kind in ('achat', 'vente', 'dividende')),
    symbol     text not null,
    quantity   numeric not null default 0,
    unit_price numeric not null default 0,
    fees       numeric not null default 0,
    amount     numeric not null default 0,
    note       text,
    created_by uuid references members(id) on delete set null,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists brvm_dividends (
    issuer      text not null,
    pay_date    date not null,
    ex_date     date not null,
    fiscal_year text,
    net_amount  numeric,
    notice_url  text,
    symbol      text,
    handled_at  timestamptz,
    quantity    numeric,
    movement_id uuid,
    primary key (issuer, pay_date)
  )`,
  `create table if not exists portfolio_daily (
    trade_date date primary key,
    value      numeric not null,
    cash       numeric not null,
    club_ytd   numeric,
    index_ytd  numeric
  )`,
];

/** Ce que la page lit des tables : rien de lisible, rien de casse. */
async function lire<T>(f: () => Promise<T>, defaut: T): Promise<T> {
  try {
    return await avecTables(TABLES, f);
  } catch {
    return defaut;
  }
}

/* ------------------------------------------------------------ releve PDF */

/**
 * Les lignes de texte d'un PDF, page apres page, de haut en bas ; chaque
 * ligne, ses cellules de gauche a droite. Le releve de la SGI est un tableau
 * dessine : les fragments d'une meme ligne partagent leur ordonnee.
 */
export async function lignesDuPdf(octets: Uint8Array): Promise<string[][]> {
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(octets);
  const lignes: string[][] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const contenu = await page.getTextContent();
    const parY = new Map<number, { x: number; s: string }[]>();
    for (const item of contenu.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const y = Math.round(item.transform[5]);
      const rangee = parY.get(y) ?? [];
      rangee.push({ x: item.transform[4], s: item.str.trim() });
      parY.set(y, rangee);
    }
    for (const y of [...parY.keys()].sort((a, b) => b - a)) {
      lignes.push(parY.get(y)!.sort((a, b) => a.x - b.x).map((c) => c.s));
    }
  }
  return lignes;
}

export type ReleveEnBase = { id: string; date: string; liquidites: number; total: number | null; lignes: LigneReleve[] };

export async function dernierReleve(): Promise<ReleveEnBase | null> {
  const sql = db();
  return lire(async () => {
    const r = await sql`
      select id::text as id, to_char(statement_date, 'YYYY-MM-DD') as date, cash, total
      from sgi_statements order by statement_date desc limit 1
    `;
    if (r.length === 0) return null;
    const lignes = await sql`
      select symbol, sgi_name, quantity, avg_cost, price, value
      from sgi_statement_lines where statement_id = ${r[0].id}::uuid order by value desc
    `;
    return {
      id: String(r[0].id),
      date: String(r[0].date),
      liquidites: Number(r[0].cash),
      total: r[0].total === null ? null : Number(r[0].total),
      lignes: lignes.map((l) => ({
        nom: String(l.sgi_name),
        symbole: l.symbol === null ? null : String(l.symbol),
        quantite: Number(l.quantity),
        cmp: Number(l.avg_cost),
        cours: Number(l.price),
        valeur: Number(l.value),
      })),
    };
  }, null);
}

/**
 * Le releve entre en base, et devient aussi un releve du portefeuille : les
 * parts de chacun se recalculent sur la valeur que la SGI certifie. Un second
 * import a la meme date remplace le premier.
 */
export async function importerReleve(r: Releve & { date: string }, auteurId: string): Promise<{ remplace: boolean }> {
  const sql = db();
  const total = r.total ?? r.liquidites + r.lignes.reduce((t, l) => t + l.valeur, 0);
  const [ligne] = await avecTables(TABLES, () => sql`
    insert into sgi_statements (statement_date, cash, total, imported_by)
    values (${r.date}::date, ${r.liquidites}, ${total}, ${auteurId}::uuid)
    on conflict (statement_date) do update
      set cash = excluded.cash, total = excluded.total, imported_by = excluded.imported_by, imported_at = now()
    returning id::text as id, (xmax <> 0) as remplace
  `);
  const id = String(ligne.id);
  await sql`delete from sgi_statement_lines where statement_id = ${id}::uuid`;
  await sql`
    insert into sgi_statement_lines (statement_id, symbol, sgi_name, quantity, avg_cost, price, value)
    select ${id}::uuid, s, n, q, c, p, v
    from unnest(${r.lignes.map((l) => l.symbole)}::text[], ${r.lignes.map((l) => l.nom)}::text[],
                ${r.lignes.map((l) => l.quantite)}::numeric[], ${r.lignes.map((l) => l.cmp)}::numeric[],
                ${r.lignes.map((l) => l.cours)}::numeric[], ${r.lignes.map((l) => l.valeur)}::numeric[])
      as t(s, n, q, c, p, v)
  `;
  const existant = await sql`select id from portfolio_valuations where valued_on = ${r.date}::date limit 1`;
  if (existant.length > 0) {
    await sql`
      update portfolio_valuations
      set total_value = ${Math.round(total)}, cash_part = ${Math.round(r.liquidites)},
          note = 'Relevé SGI importé', created_by = ${auteurId}::uuid
      where id = ${existant[0].id}::uuid
    `;
  } else {
    await sql`
      insert into portfolio_valuations (valued_on, total_value, cash_part, note, created_by)
      values (${r.date}::date, ${Math.round(total)}, ${Math.round(r.liquidites)}, 'Relevé SGI importé', ${auteurId}::uuid)
    `;
  }
  return { remplace: Boolean(ligne.remplace) };
}

/* ------------------------------------------------------------- mouvements */

export type MouvementEnBase = Mouvement & { id: string; note: string | null; saisiPar: string | null };

export async function listerMouvements(): Promise<MouvementEnBase[]> {
  const sql = db();
  return lire(async () => {
    const rows = await sql`
      select m.id::text as id, to_char(m.trade_date, 'YYYY-MM-DD') as date, m.kind, m.symbol,
             m.quantity, m.unit_price, m.fees, m.amount, m.note, c.full_name as saisi_par
      from stock_movements m left join members c on c.id = m.created_by
      order by m.trade_date desc, m.created_at desc
    `;
    return rows.map((r) => ({
      id: String(r.id),
      date: String(r.date),
      nature: String(r.kind) as NatureMouvement,
      symbole: String(r.symbol),
      quantite: Number(r.quantity),
      prix: Number(r.unit_price),
      frais: Number(r.fees),
      montant: Number(r.amount),
      note: r.note === null ? null : String(r.note),
      saisiPar: r.saisi_par === null ? null : String(r.saisi_par),
    }));
  }, []);
}

export async function ajouterMouvement(m: Mouvement & { note: string | null }, auteurId: string): Promise<void> {
  const sql = db();
  await avecTables(TABLES, () => sql`
    insert into stock_movements (trade_date, kind, symbol, quantity, unit_price, fees, amount, note, created_by)
    values (${m.date}::date, ${m.nature}, ${m.symbole}, ${m.quantite}, ${m.prix}, ${m.frais}, ${m.montant},
            ${m.note}, ${auteurId}::uuid)
  `);
}

/** Le mouvement efface, relu d'abord pour le journal ; null s'il n'existe pas. */
export async function supprimerMouvement(id: string): Promise<Record<string, unknown> | null> {
  const sql = db();
  const rows = await avecTables(TABLES, () => sql`
    delete from stock_movements where id = ${id}::uuid
    returning to_char(trade_date, 'YYYY-MM-DD') as date, kind, symbol, quantity, unit_price, fees, amount
  `);
  return rows[0] ?? null;
}

/* ---------------------------------------------------------------- cours */

export type Seance = { date: string; cours: Cours[]; indice: { cloture: number; variationJour: number; variationAnnee: number } | null };

/** La derniere seance en base : ses cours et l'indice Composite. */
export async function derniereSeance(): Promise<Seance | null> {
  const sql = db();
  return lire(async () => {
    const d = await sql`select to_char(max(trade_date), 'YYYY-MM-DD') as jour from stock_quotes`;
    const jour = d[0]?.jour ? String(d[0].jour) : null;
    if (!jour) return null;
    const [cours, indice] = await Promise.all([
      sql`select symbol, name, close, change_pct from stock_quotes where trade_date = ${jour}::date`,
      sql`select close, day_pct, ytd_pct from index_quotes where trade_date = ${jour}::date and code = 'COMPOSITE'`,
    ]);
    return {
      date: jour,
      cours: cours.map((c) => ({ symbole: String(c.symbol), nom: String(c.name), cloture: Number(c.close), variation: Number(c.change_pct) })),
      indice: indice[0]
        ? { cloture: Number(indice[0].close), variationJour: Number(indice[0].day_pct), variationAnnee: Number(indice[0].ytd_pct) }
        : null,
    };
  }, null);
}

export type PointDuSoir = { date: string; valeur: number; clubAnnee: number | null; indiceAnnee: number | null };

export async function pointsDuSoir(annee: number): Promise<PointDuSoir[]> {
  const sql = db();
  return lire(async () => {
    const rows = await sql`
      select to_char(trade_date, 'YYYY-MM-DD') as date, value, club_ytd, index_ytd
      from portfolio_daily where extract(year from trade_date) = ${annee} order by trade_date
    `;
    return rows.map((r) => ({
      date: String(r.date),
      valeur: Number(r.value),
      clubAnnee: r.club_ytd === null ? null : Number(r.club_ytd),
      indiceAnnee: r.index_ytd === null ? null : Number(r.index_ytd),
    }));
  }, []);
}

/* -------------------------------------------------------------- l'etat */

/**
 * Le portefeuille ce soir : les positions du dernier releve, les mouvements
 * inscrits depuis, valorisees au dernier cours. Null tant qu'aucun releve
 * n'a ete importe : sans point de depart, rien ne se calcule.
 */
export async function etatBourse(aujourdhui: Date = new Date()) {
  const [releve, mouvements, seance, apports, valos] = await Promise.all([
    dernierReleve(),
    listerMouvements(),
    derniereSeance(),
    listerApports(),
    listerValorisations(),
  ]);
  if (!releve) return { releve: null, mouvements, seance } as const;

  /* Un mouvement date d'apres ce jour n'a pas encore eu lieu. */
  const jour = aujourdhui.toISOString().slice(0, 10);
  const apres = mouvements.filter((m) => m.date > releve.date && m.date <= jour);
  const positions = positionsApres(releve, apres);
  const liquidites = liquiditesApres(
    releve,
    apports.map((a) => ({ date: a.date_transfert, net: netApport(a), frais: a.frais })),
    apres,
  );
  const cours = new Map((seance?.cours ?? []).map((c) => [c.symbole, c]));
  /* Un cours plus ancien que le releve ne le remplace pas : le releve est plus frais. */
  const coursValables = seance && seance.date >= releve.date ? cours : new Map<string, Cours>();
  const repli = new Map(releve.lignes.filter((l) => l.symbole).map((l) => [l.symbole!, l.cours]));
  const valeur = valoriser(positions, coursValables, repli, liquidites);

  const annee = aujourdhui.getUTCFullYear();
  const depart = departDeLAnnee(
    valos.map((v) => ({ date: v.date_valo, total: v.total })),
    annee,
  );
  const fin = `${annee}-12-31`;
  const apportsAnnee = depart
    ? apports.filter((a) => a.date_transfert > depart.date && a.date_transfert <= fin).reduce((t, a) => t + netApport(a), 0)
    : 0;
  const clubAnnee = depart ? performance(depart.total, valeur.total, apportsAnnee) : null;
  const dividendes = mouvements.filter((m) => m.nature === "dividende" && m.date.startsWith(String(annee)));

  return {
    releve,
    mouvements,
    seance,
    positions: valeur.lignes,
    liquidites,
    titres: valeur.titres,
    total: valeur.total,
    dateCours: seance && seance.date >= releve.date ? seance.date : releve.date,
    depart,
    clubAnnee,
    indiceAnnee: seance?.indice?.variationAnnee ?? null,
    dividendes,
  } as const;
}

/* ------------------------------------------------------- passage du soir */

const PAGES = {
  cours: "https://www.brvm.org/fr/cours-actions/0",
  dividendes: "https://www.brvm.org/fr/esv/paiement-de-dividendes",
  indices: "https://www.brvm.org/fr/indices",
};

async function pageBrvm(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" }, cache: "no-store", signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${url} : ${r.status}`);
  return r.text();
}

/**
 * Chaque soir de semaine : les cours et l'indice de la seance lus sur
 * brvm.org, puis la valeur du portefeuille ce soir-la, gardee pour la courbe.
 * Un jour ferie, brvm.org redonne la seance precedente : elle se reecrit a
 * l'identique.
 */
export async function passageBourse(maintenant: Date = new Date()) {
  const [htmlCours, htmlIndices] = await Promise.all([pageBrvm(PAGES.cours), pageBrvm(PAGES.indices)]);
  const cours = lireCoursBrvm(htmlCours);
  const indice = lireIndiceComposite(htmlIndices);
  const jour = dateDeSeance(htmlCours) ?? maintenant.toISOString().slice(0, 10);
  if (cours.length === 0) throw new Error("brvm.org : aucun cours lisible.");

  const sql = db();
  await avecTables(TABLES, () => sql`
    insert into stock_quotes (trade_date, symbol, name, close, change_pct)
    select ${jour}::date, s, n, c, v
    from unnest(${cours.map((c) => c.symbole)}::text[], ${cours.map((c) => c.nom)}::text[],
                ${cours.map((c) => c.cloture)}::numeric[], ${cours.map((c) => c.variation)}::numeric[]) as t(s, n, c, v)
    on conflict (trade_date, symbol) do update set name = excluded.name, close = excluded.close, change_pct = excluded.change_pct
  `);
  if (indice) {
    await sql`
      insert into index_quotes (trade_date, code, close, day_pct, ytd_pct)
      values (${jour}::date, 'COMPOSITE', ${indice.cloture}, ${indice.variationJour}, ${indice.variationAnnee})
      on conflict (trade_date, code) do update set close = excluded.close, day_pct = excluded.day_pct, ytd_pct = excluded.ytd_pct
    `;
  }

  /* Les dividendes d'abord : ceux du jour entrent dans les liquidites du soir. */
  const dividendes = await passageDividendes(jour).catch((e) => ({ erreur: String(e) }));
  const etat = await etatBourse(new Date(`${jour}T12:00:00Z`));
  if (etat.releve) {
    await sql`
      insert into portfolio_daily (trade_date, value, cash, club_ytd, index_ytd)
      values (${jour}::date, ${etat.total}, ${etat.liquidites}, ${etat.clubAnnee}, ${indice?.variationAnnee ?? null})
      on conflict (trade_date) do update
        set value = excluded.value, cash = excluded.cash, club_ytd = excluded.club_ytd, index_ytd = excluded.index_ytd
    `;
  }
  return { jour, cours: cours.length, indice: indice?.cloture ?? null, valeur: etat.releve ? Math.round(etat.total) : null, dividendes };
}

/**
 * Les dividendes, sans saisie : les avis de brvm.org entrent en base ; le
 * jour du paiement venu, le site inscrit ce que le club touche (actions
 * detenues a la veille de la date ex, fois le net par action) et previent le
 * bureau, qui corrige si la SGI a verse autre chose. Un avis n'est traite
 * qu'une fois, meme supprime ensuite : le bureau garde le dernier mot.
 *
 * Seuls comptent les paiements posterieurs au releve : les autres y sont deja,
 * dans les liquidites.
 */
export async function passageDividendes(jour: string) {
  const avis = lireDividendesBrvm(await pageBrvm(PAGES.dividendes));
  const sql = db();
  if (avis.length > 0) {
    await avecTables(TABLES, () => sql`
      insert into brvm_dividends (issuer, pay_date, ex_date, fiscal_year, net_amount, notice_url, symbol)
      select i, p, e, f, m, u, s
      from unnest(${avis.map((a) => a.emetteur)}::text[], ${avis.map((a) => a.paiement)}::date[], ${avis.map((a) => a.ex)}::date[],
                  ${avis.map((a) => a.exercice)}::text[], ${avis.map((a) => a.montant)}::numeric[], ${avis.map((a) => a.avis)}::text[],
                  ${avis.map((a) => symboleDuDividende(a))}::text[]) as t(i, p, e, f, m, u, s)
      on conflict (issuer, pay_date) do nothing
    `);
  }
  const releve = await dernierReleve();
  if (!releve) return { avis: avis.length, inscrits: 0 };

  /* Chaque avis echu est reserve par ce passage avant d'etre traite : deux passages ne l'inscrivent pas deux fois. */
  const echus = await avecTables(TABLES, () => sql`
    update brvm_dividends set handled_at = now()
    where handled_at is null and pay_date <= ${jour}::date and pay_date > ${releve.date}::date
    returning issuer, to_char(pay_date, 'YYYY-MM-DD') as paiement, to_char(ex_date, 'YYYY-MM-DD') as ex,
              net_amount, symbol, notice_url
  `);
  if (echus.length === 0) return { avis: avis.length, inscrits: 0 };

  const mouvements = await listerMouvements();
  const inscrits: string[] = [];
  const douteux: string[] = [];
  for (const d of echus) {
    const symbole = d.symbol === null ? null : String(d.symbol);
    const net = d.net_amount === null ? null : Number(d.net_amount);
    if (!symbole || net === null) {
      douteux.push(String(d.issuer));
      continue;
    }
    const q = quantiteALaVeille(symbole, String(d.ex), releve, mouvements);
    if (q <= 0) continue;
    const montant = Math.round(q * net);
    const [m] = await sql`
      insert into stock_movements (trade_date, kind, symbol, quantity, unit_price, fees, amount, note)
      values (${String(d.paiement)}::date, 'dividende', ${symbole}, ${q}, ${net}, 0, ${montant},
              ${`Automatique : ${q} actions × ${String(net).replace(".", ",")} FCFA net, avis BRVM`})
      returning id::text as id
    `;
    await sql`
      update brvm_dividends set quantity = ${q}, movement_id = ${m.id}::uuid
      where issuer = ${String(d.issuer)} and pay_date = ${String(d.paiement)}::date
    `;
    inscrits.push(`${symbole} : ${nombre(montant)} FCFA`);
  }

  if (inscrits.length + douteux.length > 0) {
    const bureau = (await listerMembres()).filter((m) => m.actif && peut(m, "opererEnBourse")).map((m) => m.id);
    if (inscrits.length > 0) {
      await envoyerAlertes(bureau, {
        titre: inscrits.length > 1 ? "Dividendes encaissés" : "Dividende encaissé",
        corps: `${inscrits.join(", ")}. Inscrit d'après l'avis de la BRVM : corrige-le si la SGI a versé autre chose.`,
        corpsVoile: "Inscrit d'après l'avis de la BRVM : corrige-le si la SGI a versé autre chose.",
        url: "/bourse",
        etiquette: `dividendes-${jour}`,
      });
    }
    if (douteux.length > 0) {
      await envoyerAlertes(bureau, {
        titre: "Dividende à vérifier",
        corps: `${douteux.join(", ")} : le site ne sait pas à quel titre le rattacher. Si le club le détient, inscris-le à la main.`,
        url: "/bourse",
        etiquette: `dividendes-douteux-${jour}`,
      });
    }
  }
  return { avis: avis.length, inscrits: inscrits.length, douteux: douteux.length };
}

/** Corrige le net recu d'un dividende ; la ligne doit etre un dividende. */
export async function corrigerDividende(id: string, montant: number): Promise<Record<string, unknown> | null> {
  const sql = db();
  const rows = await avecTables(TABLES, () => sql`
    update stock_movements m set amount = ${montant}
    from (select id, amount as avant from stock_movements where id = ${id}::uuid and kind = 'dividende') a
    where m.id = a.id
    returning m.symbol, to_char(m.trade_date, 'YYYY-MM-DD') as date, a.avant, m.amount
  `);
  return rows[0] ?? null;
}
