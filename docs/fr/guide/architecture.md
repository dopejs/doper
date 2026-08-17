# Architecture

## La propriété de chaque côté

```
TSX / hooks             →  Mutation Stream  →   Scene / Layout / Paint
（couche TypeScript）       binaire, par lots     （Core Rust, wasm）
                                                        ↓
Lecteur Canvas2D        ←   DisplayList      ←      Picture
```

**La couche TypeScript possède l'arbre de composants, le Core possède le Scene. Les deux ne partagent
aucun objet mutable.** Toute communication entre eux passe par des flux binaires versionnés :
petit-boutiste, alignés sur quatre octets, sous forme d'instructions. Le récepteur valide opcode,
longueur, alignement, identifiants et arithmétique avant de toucher la mémoire, et une entrée malformée
est rejetée de façon atomique au lieu d'être appliquée partiellement.

Cette frontière n'est pas une optimisation de performance mais une frontière de correction : même si
les octets viennent d'ordinaire de l'encodeur de ce projet, le décodeur les traite comme une entrée non
fiable et est couvert par du fuzzing.

## Deux horloges

L'horloge d'interface (thread principal) et l'horloge de rendu (Worker) sont indépendantes :

- Le thread principal collecte les entrées, exécute l'arbre de composants et valide des images de Mutation.
- Le Worker pilote la physique du défilement, les animations, la mise en page et la composition.

**Le défilement en régime établi n'appelle pas la couche TypeScript.** Les données manquantes sont
dessinées avec des substituts et complétées lors d'images ultérieures. Ainsi, quand du code applicatif
bloque le thread principal 200 ms, le défilement et les animations restent continus — ce scénario est
protégé par des tests automatiques d'injection de panne.

## Chaîne de repli

La détection de capacités choisit le transport dans l'ordre, avec trois niveaux fonctionnellement
équivalents :

1. **SharedArrayBuffer** — nécessite l'isolation entre origines (COOP/COEP)
2. **postMessage** — quand SAB n'est pas disponible
3. **Canvas2D sur le thread principal** — quand ni Worker ni OffscreenCanvas ne sont disponibles

```ts
const root = await createHostedCanvasRoot(canvas, {
  transport: { preference: "sab" }, // simple préférence ; le repli s'applique si elle n'est pas satisfaite
});
console.log(root.mode); // "sab" | "post-message" | "main-thread"
```

Le [Playground](/fr/playground) de ce site en est l'exemple vivant : GitHub Pages ne peut pas envoyer
d'en-têtes COOP/COEP, la version publiée fonctionne donc via postMessage, et le badge de transport en
haut de page l'indique honnêtement.

## Modèle d'invalidation

**La sémantique de chaque prop détermine son domaine d'invalidation.** L'appelant ne marque rien comme
sale à la main et il n'existe aucune échappatoire de type `forceUpdate`.

Chaque propriété déclare, dans un schéma à source unique, si elle affecte la mise en page, le dessin,
le hit testing ou la sémantique. Modifier `opacity` ne déclenche pas de recalcul de mise en page ;
modifier `width` si. Les bitmaps de saleté sont tenus par domaine et `onFrame` expose le nombre de nœuds
sales de chacun.

Le choix est « invalidation la plus étroite possible, filet de sécurité par tests de propriétés » : le
rendu incrémental doit correspondre au rendu complet pixel par pixel, et les tests différentiels
réduisent tout contre-exemple au cas d'échec minimal.

## Représentation du Scene

Dans le Core, le Scene est en SoA (structure de tableaux plutôt que tableau de structures) :

- Les identifiants de nœud portent une **génération** : réutiliser un emplacement ne revalide jamais un
  identifiant périmé.
- Après commit, l'**ordre topologique** est conservé : un parent précède toujours ses enfants.
- Le compactage des modifications structurelles a lieu une fois par commit, et non une fois par mutation.
- Les résultats de mise en page sont comparés en bloc depuis des SoA à double tampon, sans allocation de
  closure ni d'écouteur par nœud sur le chemin chaud.

## Backend interchangeable

Le Core émet un DisplayList binaire et plat ; le backend n'est qu'un lecteur. Le backend Canvas2D est
une boucle sur tableaux typés économe en allocations : **appeler wasm→JS à chaque dessin n'est pas un
chemin de rendu acceptable**.

Le même DisplayList alimente un prototype wgpu isolé, et les deux sorties sont comparées pixel par
pixel. Adopter WebGPU ou non est une décision fondée sur des données ; voir
[ADR-0006](/adr/0006-webgpu-backend-decision).

## Déterminisme

Le temps, l'aléa et les flux d'entrée sont injectables ou rejouables, et la sortie du Core ne dépend pas
de l'ordre d'ordonnancement des threads. Une archive `DOPR` enregistre les flux Mutation et Input dans
leur ordre d'origine et se rejoue de manière déterministe sans navigateur, en environnement headless :
un incident de production se reproduit ainsi en local, tandis que les flux d'édition sensibles sont
explicitement exclus de l'enregistrement.

## Pour aller plus loin

Les algorithmes, structures de données et critères d'acceptation complets figurent dans le
[document de conception technique](/design).
