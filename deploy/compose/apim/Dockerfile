# Imagen de laboratorio de Nexo sobre WSO2 API Manager 4.7.0 (todo en uno).
FROM wso2/wso2am:4.7.0

ARG PG_JDBC_VERSION=42.7.13
ARG RGXGEN_VERSION=1.4

# Driver JDBC de PostgreSQL y rgxgen (lo requiere la generación de SDK en Python).
ADD --chown=wso2carbon:wso2 https://repo1.maven.org/maven2/org/postgresql/postgresql/${PG_JDBC_VERSION}/postgresql-${PG_JDBC_VERSION}.jar \
    /home/wso2carbon/wso2-config-volume/repository/components/lib/postgresql-${PG_JDBC_VERSION}.jar
ADD --chown=wso2carbon:wso2 https://repo1.maven.org/maven2/com/github/curious-odd-man/rgxgen/${RGXGEN_VERSION}/rgxgen-${RGXGEN_VERSION}.jar \
    /home/wso2carbon/wso2-config-volume/repository/components/lib/rgxgen-${RGXGEN_VERSION}.jar

# El entrypoint oficial copia wso2-config-volume sobre la instalación al iniciar.
COPY --chown=wso2carbon:wso2 config/ /home/wso2carbon/wso2-config-volume/
