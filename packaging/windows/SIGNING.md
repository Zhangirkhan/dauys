# Подпись Windows-агента и установщика Dauys

Цифровая подпись в репозитории **не имитируется**. Без сертификата SmartScreen
может показывать предупреждение при первом запуске `DauysSetup-x64.exe`.

## Что подписывать

1. `dist/windows/dauys-agent.exe` — SEA-бинарник агента  
2. `dist/windows-installer/DauysSetup-x64.exe` — установщик Inno Setup  

## Требования

- Сертификат Authenticode (OV/EV) организации  
- Windows SDK: `signtool.exe`  
- Timestamp-сервер (например `http://timestamp.digicert.com`)  

## Пример

```bat
set CERT=Company Code Signing
set TS=http://timestamp.digicert.com

signtool sign /n "%CERT%" /fd SHA256 /tr %TS% /td SHA256 ^
  dist\windows\dauys-agent.exe

signtool sign /n "%CERT%" /fd SHA256 /tr %TS% /td SHA256 ^
  dist\windows-installer\DauysSetup-x64.exe

signtool verify /pa dist\windows-installer\DauysSetup-x64.exe
```

После подписи пересоберите установщик **только если** подписываете `.exe` агента
до упаковки в Inno; либо подпишите оба артефакта после `pnpm build:agent:windows-installer`.

Рекомендуемый порядок:

1. `pnpm build:agent:windows`  
2. Подписать `dauys-agent.exe`  
3. `pnpm build:agent:windows-installer` (подхватит уже подписанный агент)  
4. Подписать `DauysSetup-x64.exe`  
