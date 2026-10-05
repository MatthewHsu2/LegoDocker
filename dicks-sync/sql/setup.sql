-- Run once, as a Spirit Web DB admin, against spiritwebdb (Azure SQL).
-- Replace <set by admin> with a new password and put the same value in dicks-sync.env.
CREATE SCHEMA ext;
GO

CREATE TABLE ext.DicksSellThrough (
    WeekEnding      date           NOT NULL,
    Style           nvarchar(50)   NOT NULL,
    Description     nvarchar(200)  NULL,
    UnitsSold       int            NOT NULL,
    SalesDollars    decimal(18, 2) NULL,
    OnHandUnits     int            NULL,
    OnHandDollars   decimal(18, 2) NULL,
    InTransitUnits  int            NULL,
    OnOrderUnits    int            NULL,
    IsRefill        bit            NOT NULL,
    SourceFile      nvarchar(200)  NOT NULL,
    LoadedAt        datetime2(0)   NOT NULL,
    CONSTRAINT PK_DicksSellThrough PRIMARY KEY (WeekEnding, Style)
);
GO

CREATE USER dicks_sync WITH PASSWORD = '<set by admin>';
GRANT SELECT, INSERT, UPDATE, DELETE ON SCHEMA::ext TO dicks_sync;
GO
