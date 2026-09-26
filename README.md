# VapeLab: kody zamówień Discord

Strona tworzy zamówienie na serwerze i zwraca kod `VL-...`. Na Discordzie `/kodzamowienia` pokazuje dane zamówienia, a `/ticket` z wymaganym polem `kod` tworzy prywatny kanał z produktami, sumą, płatnością, telefonem i paczkomatem.

## Uruchomienie

1. Zainstaluj Node.js 18 lub nowszy.
2. W terminalu w folderze projektu uruchom `npm install`.
3. Skopiuj `.env.example` do `.env` i wpisz dane aplikacji Discord: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` oraz `DISCORD_GUILD_ID` (ID serwera Discord). Nie udostępniaj pliku `.env`.
4. Uruchom `npm start` i otwórz `http://localhost:3000`.
5. Zaproś bota na serwer z zakresami OAuth2 `bot` i `applications.commands`, nadając mu uprawnienia `Manage Channels`, `View Channels`, `Send Messages` i `Read Message History`.

Komenda zostanie zarejestrowana na wskazanym serwerze. Zamówienia są przechowywane w `data/orders.json`. Wdrożenie publiczne wymaga hostowania strony i tego serwera razem pod tym samym adresem HTTPS; bot i API korzystają z tego samego zapisu.

## Połączenie istniejącego bota ticketów
## Konta i trwałość danych

Rejestracja wymaga potwierdzenia ukończenia 18 lat i hasła o długości co najmniej 10 znaków. Hasła są przechowywane jako skróty `scrypt`; sesja jest w ciasteczku `HttpOnly` i wygasa po 7 dniach. Po restarcie serwera użytkownik musi zalogować się ponownie.

Konta i zamówienia są zapisywane w plikach JSON w `data/`. Pliki kont są wykluczone z Gita. Na Renderze skonfiguruj trwały dysk i ustaw zmienną `DATA_DIRECTORY` na jego punkt montowania; bez trwałego dysku dane JSON mogą zniknąć po restarcie lub wdrożeniu.

## Połączenie istniejącego bota ticketów

Zaktualizowany `bot.py` otwiera formularz po kliknięciu `Otwórz zgłoszenie`. Po wpisaniu kodu zamówienia, paczkomatu i telefonu pobiera zamówienie z API i tworzy ticket z pełnymi danymi. Ustaw w środowisku bota `DISCORD_TOKEN` oraz `SKLEP_API_URL`. Gdy bot działa poza tym komputerem, `SKLEP_API_URL` musi być publicznym adresem HTTPS sklepu, a nie `localhost`.