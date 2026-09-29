# Como abrir o PR no AgentKit (Renato, ~15 min)

1. Fork: https://github.com/coinbase/agentkit → botão **Fork**.
2. No seu PC (Git Bash ou cmd):
   ```
   git clone https://github.com/<seu-usuario>/agentkit && cd agentkit
   git checkout -b feat/degenscan-intel-action-provider
   ```
3. Copie os arquivos:
   - `integrations/agentkit/typescript/degenscanIntel/*` → `typescript/agentkit/src/action-providers/degenscanIntel/`
   - `integrations/agentkit/python/degenscan_intel/*` → `python/coinbase-agentkit/coinbase_agentkit/action_providers/degenscan_intel/`
   - `integrations/agentkit/python/tests/test_degenscan_intel_action_provider.py` → `python/coinbase-agentkit/tests/action_providers/degenscan_intel/`
4. Registre as exportações:
   - `typescript/agentkit/src/action-providers/index.ts` → adicionar `export * from "./degenscanIntel";`
   - `python/coinbase-agentkit/coinbase_agentkit/action_providers/__init__.py` → adicionar import + `__all__` (mesmo padrão do `pyth`)
5. Rode: `cd typescript && pnpm i && pnpm test && pnpm run format && pnpm run lint:fix && pnpm run changeset` (patch; texto: "Added Degenscan Intel action provider"). Python: `cd python/coinbase-agentkit && make test`, crie `changelog.d/degenscan-intel.feature.md` com uma linha.
6. `git add -A && git commit -m "feat(action-providers): add Degenscan Intel provider (TS + Python)" && git push -u origin feat/degenscan-intel-action-provider`
7. Abra o PR no GitHub com o texto de `PR.md`. Marque as caixas do checklist que você rodou.

Se algum passo do pnpm/make falhar, me manda o print — corrijo na hora.
